import {
  REDIS_VERSION,
  MONGO_VERSION,
  POSTGRES_VERSION,
} from '../../demo/constants';
import { getContainerName, getImageName, demoIsDeployed } from '../../demo/utils';
import { ConduitPackageConfiguration, Package, PackageConfiguration } from '../../demo/types';
import { booleanPrompt, promptWithOptions } from '../../utils/cli';
import { getPort, portNumbers } from '../../utils/getPort';
import { Docker } from '../../docker/Docker';
import DemoStart from './start';
import DemoCleanup from './cleanup';
import { Command, Flags, CliUx } from '@oclif/core';
import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';

const DEMO_CONFIG: { [key: string]: Pick<PackageConfiguration, 'env' | 'ports'> } = {
  'Core': {
    env: {
      REDIS_HOST: 'conduit-redis',
      REDIS_PORT: '',
      MASTER_KEY: 'M4ST3RK3Y',
      PORT: '', // HTTP
      SOCKET_PORT: '',
    },
    ports: ['55152', '3000', '3001'], // gRPC, HTTP, Sockets
  },
  'UI': {
    env: {
      CONDUIT_URL: '',
      MASTER_KEY: 'M4ST3RK3Y',
    },
    ports: ['8080'],
  },
  'Database': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
      DB_TYPE: '',
      DB_CONN_URI: '',
    },
    ports: [],
  },
  'Authentication': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
    },
    ports: [],
  },
  'Chat': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
    },
    ports: [],
  },
  'Email': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
    },
    ports: [],
  },
  'Forms': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
    },
    ports: [],
  },
  'PushNotifications': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
    },
    ports: [],
  },
  'SMS': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
    },
    ports: [],
  },
  'Storage': {
    env: {
      CONDUIT_SERVER: '',
      REGISTER_NAME: 'true',
    },
    ports: [],
  },
  'Redis': {
    env: {},
    ports: ['6379'],
  },
  'Mongo': {
    env: {
      MONGO_INITDB_ROOT_USERNAME: 'conduit',
      MONGO_INITDB_ROOT_PASSWORD: 'pass',
    },
    ports: ['27017'],
  },
  'Postgres': {
    env: {
      POSTGRES_USER: 'conduit',
      POSTGRES_PASSWORD: 'pass',
    },
    ports: ['5432'],
  },
}

export default class DemoSetup extends Command {
  static description = 'Bootstraps a local Conduit demo deployment with minimal configuration';
  static flags = {
    config: Flags.boolean({
      description: 'Enable manual deployment configuration',
    }),
  };

  private readonly networkName = 'conduit-demo';
  private selectedPackages: Package[] = ['Core', 'UI', 'Database', 'Authentication', 'Redis'];
  private conduitTags: string[] = [];
  private conduitUiTags: string[] = [];
  private selectedDbEngine: 'mongodb' | 'postgresql' = 'mongodb';
  private selectedConduitTag: string = '';
  private selectedConduitUiTag: string = '';
  private demoConfiguration: ConduitPackageConfiguration = {
    networkName: this.networkName,
    packages: {},
  }

  async run() {
    const userConfiguration = (await this.parse(DemoSetup)).flags.config;

    // Handle Existing Demo Deployments
    if (await demoIsDeployed(this)) {
      const replaceDemo = await booleanPrompt(
        'An existing demo deployment was detected. Are you sure you wish to overwrite it?'
      );
      if (replaceDemo) {
        await DemoCleanup.run(['--silent']);
      } else {
        console.log('Setup canceled');
        process.exit(0);
      }
    }

    // Configuration
    await this.getConduitTags();
    await this.getConduitUiTags();
    if (userConfiguration) {
      await this.configureDeployment();
    } else {
      this.selectedConduitTag = this.conduitTags[0];
      this.selectedConduitUiTag = this.conduitUiTags[0];
      this.selectedPackages.push('Mongo');
    }
    await this.processConfiguration();
    await this.storeDemoConfig(this);

    // Call demo:start
    await DemoStart.run();
  }

  async configureDeployment() {
    // Select Tags
    let latestConduitTag = (this.conduitTags)[0];
    let latestConduitUiTag = (this.conduitUiTags)[0];
    while (!this.conduitTags.includes(this.selectedConduitTag)) {
      this.selectedConduitTag = await CliUx.ux.prompt('Specify your desired Conduit version', { default: latestConduitTag });
    }
    while (!this.conduitUiTags.includes(this.selectedConduitUiTag)) {
      this.selectedConduitUiTag = await CliUx.ux.prompt('Specify your desired Conduit UI version', { default: latestConduitUiTag });
    }

    // Select Modules
    const nonModules: Package[] = ['Core', 'UI', 'Redis', 'Mongo', 'Postgres'];
    const modules = this.selectedPackages.filter(pkg => !nonModules.includes(pkg));
    console.log('\nThe following Conduit modules are going to be brought up by default:')
    console.log(modules.join(', '));
    const chooseExtraModules = await booleanPrompt('\nSpecify additional modules?', 'no');
    if (chooseExtraModules) {
      const availableExtras = Object.keys(DEMO_CONFIG).filter(
        pkg => !this.selectedPackages.includes(pkg as Package) && !nonModules.includes(pkg as Package)
      ) as Package[];
      for (const pkg of availableExtras) {
        const addModule = await booleanPrompt(`Bring up ${pkg}?`, 'no');
        if (addModule) this.selectedPackages.push(pkg);
      }
    }

    // Select Database Engine
    const dbEngineType = await promptWithOptions(
      '\nSpecify database engine type to be used',
      ['mongodb', 'postgres'],
      'mongodb',
      false,
    );
    this.selectedPackages.push(dbEngineType === 'mongodb' ? 'Mongo' : 'Postgres');

    // Specify DB Engine Credentials
    const dbUsername = await CliUx.ux.prompt('Specify database username', { default: 'conduit' });
    const dbPassword = await CliUx.ux.prompt('Specify database password', { default: 'pass' });
    if (dbEngineType === 'mongodb') {
      this.demoConfiguration.packages['Mongo'].env.MONGO_INITDB_ROOT_USERNAME = dbUsername;
      this.demoConfiguration.packages['Mongo'].env.MONGO_INITDB_ROOT_PASSWORD = dbPassword;
    } else {
      this.demoConfiguration.packages['Postgres'].env.POSTGRES_PASSWORD = dbPassword;
      this.demoConfiguration.packages['Postgres'].env.POSTGRES_USER = dbUsername;
    }
  }

  private async processConfiguration() {
    this.sortPackages();
    const docker = new Docker(this.networkName);
    await docker.createNetwork();
    console.log('\nSetting up container environment. This may take some time...')
    for (const pkg of this.selectedPackages) {
      const containerName = getContainerName(pkg);
      this.demoConfiguration.packages[pkg] = {
        image: getImageName(pkg),
        tag: pkg === 'Redis' ? REDIS_VERSION
          : pkg === 'Mongo' ? MONGO_VERSION
          : pkg === 'Postgres' ? POSTGRES_VERSION
          : pkg === 'UI' ? this.selectedConduitUiTag
          : this.selectedConduitTag,
        containerName: containerName,
        env: DEMO_CONFIG[pkg].env,
        ports: DEMO_CONFIG[pkg].ports.length > 0 ? await this.getServicePortBindings(DEMO_CONFIG[pkg].ports) : [],
      };
      await docker.pull(pkg, this.demoConfiguration.packages[pkg]!.tag);
    }
    // Update Env Vars
    this.demoConfiguration.packages['Core'].env = {
      ...this.demoConfiguration.packages['Core'].env,
      REDIS_PORT: this.demoConfiguration.packages['Redis'].ports[0].split(':')[1],
      PORT: this.demoConfiguration.packages['Core'].ports[1].split(':')[1],
      SOCKET_PORT: this.demoConfiguration.packages['Core'].ports[2].split(':')[1],
    };
    let dbUsername: string;
    let dbPassword: string;
    let dbHost: string;
    let dbPort: string;
    let dbDatabase: string;
    if (this.selectedDbEngine === 'mongodb') {
      dbUsername = this.demoConfiguration.packages['Mongo'].env.MONGO_INITDB_ROOT_USERNAME;
      dbPassword = this.demoConfiguration.packages['Mongo'].env.MONGO_INITDB_ROOT_PASSWORD;
      dbHost = 'conduit-mongo';
      dbPort = this.demoConfiguration.packages['Mongo'].ports[0].split(':')[1];
      dbDatabase = ''; // specifying this is trickier for Mongo
    } else {
      dbUsername = this.demoConfiguration.packages['Postgres'].env.POSTGRES_USER;
      dbPassword = this.demoConfiguration.packages['Postgres'].env.POSTGRES_PASSWORD;
      dbHost = 'conduit-postgres';
      dbPort = this.demoConfiguration.packages['Postgres'].ports[0].split(':')[1];
      dbDatabase = 'conduit';
    }
    this.demoConfiguration.packages['Database'].env = {
      ...this.demoConfiguration.packages['Database'].env,
      DB_TYPE: this.selectedDbEngine,
      DB_CONN_URI: `${this.selectedDbEngine}://${dbUsername}:${dbPassword}@${dbHost}:${dbPort}`
        + dbDatabase ? `/${dbDatabase}` : '',
    };
    const conduitGrpcPort = this.demoConfiguration.packages['Core'].ports[0].split(':')[1];
    const conduitHttpPort = this.demoConfiguration.packages['Core'].ports[1].split(':')[1];
    this.demoConfiguration.packages['UI'].env['CONDUIT_URL'] = `http://localhost:${conduitHttpPort}`;
    Object.keys(this.demoConfiguration.packages).forEach(pkg => {
      if (this.demoConfiguration.packages[pkg].env.hasOwnProperty('CONDUIT_SERVER')) {
        this.demoConfiguration.packages[pkg].env['CONDUIT_SERVER'] = `${getContainerName('Core')}:${conduitGrpcPort}`;
      }
    });
    // Display Information
    console.log(`\n\nDatabase Credentials for ${this.selectedDbEngine === 'mongodb' ? 'MongoDB' : 'PostgreSQL'}:`);
    console.log(`Username:\t${dbUsername}`);
    console.log(`Password:\t${dbPassword}`);
    console.log('\n\n');
  }

  private sortPackages() {
    const reordered = this.selectedPackages.filter(pkg => ['Redis', 'Mongo', 'Postgres'].includes(pkg));
    reordered.forEach(pkg => {
      const packageIndex = this.selectedPackages.indexOf(pkg);
      this.selectedPackages.splice(packageIndex, 1);
      this.selectedPackages.unshift(pkg);
    });
  }

  private async storeDemoConfig(command: Command) {
    await fs.ensureFile(path.join(command.config.configDir, 'demo.json'));
    await fs.writeJSON(path.join(command.config.configDir, 'demo.json'), this.demoConfiguration);
  }

  private async getConduitTags() {
    this.conduitTags = await this._getTags('ConduitPlatform/Conduit');
  }

  private async getConduitUiTags() {
    this.conduitUiTags = await this._getTags('ConduitPlatform/Conduit-UI');
  }

  private async _getTags(project: string) {
    const res = await axios.get(
      `https://api.github.com/repos/${project}/releases`,
      { headers: { Accept: 'application/vnd.github.v3+json' } },
    );
    const releases: string[] = [];
    const rcReleases: string[] = [];
    res.data.forEach((release: any) => {
      if (release.tag_name.indexOf('-rc') === -1) {
        releases.push(release.tag_name);
      } else {
        rcReleases.push(release.tag_name);
      }
    });
    releases.sort().reverse();
    rcReleases.sort().reverse();
    releases.push(...rcReleases);
    releases.push('latest');
    return releases;
  }

  private async getServicePortBindings(requestedPorts: string[]) {
    const portBindings: string[] = [];
    for (const p of requestedPorts) {
      const portRange = portNumbers(Number(p), Number(p) + 5); // target range or default to any available
      portBindings.push(`${await getPort({ port: portRange })}:${p}`); // host:container
    }
    return portBindings;
  }
}
