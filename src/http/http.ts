import axios, { AxiosResponse } from 'axios';

export class Requests {
  private readonly URL: string;
  private readonly baseHeaders: {
    masterkey: string;
  };
  private token?: string;
  private clientValidation: {
    enabled: boolean,
    clientId?: string,
    clientSecret?: string,
  } = { enabled: false };

  constructor(url: string, masterKey: string) {
    this.URL = url;
    this.baseHeaders = {
      masterkey: masterKey,
    };
    // Interceptors
    const self = this;
    axios.interceptors.request.use(
      (config) => {
        config.headers = self.getRequestHeaders();
        return config;
      },
      (error) => {
        console.log(error);
        return Promise.reject(error.response);
      }
    );
  }

  async initialize(username: string, password: string) {
    this.token = await this.loginRequest(username, password);
    const securityConfig = await this.getModuleConfig('security')
      .catch(_ => {
        console.log('Failed to retrieve Conduit Security configuration');
        process.exit(-1);
      });
    if (securityConfig.clientValidation.enabled) {
      this.clientValidation.enabled = true;
      const clients = await this.getSecurityClients();
      let securityClient = clients.find(client => client.platform === 'LINUX' && client.alias === 'CLI'); // We should add a 'CLI' platform
      if (!securityClient) {
        securityClient = await this.createSecurityClient();
      }
      this.clientValidation.clientId = securityClient.clientId;
      this.clientValidation = securityClient.clientSecret;
    }
  }

  private getRequestHeaders() {
    return {
      ...this.baseHeaders,
      ...(this.token && { Authorization: `JWT ${this.token}` }),
    };
  }

  get securityClient() {
    return this.clientValidation.enabled
      ? { clientId: this.clientValidation.clientId!, clientSecret: this.clientValidation.clientSecret! }
      : null;
  }

  // API Requests
  async httpHealthCheck() {
    return axios.get(`${this.URL}/health`)
      .then(_ => { return true; })
      .catch(_ => { return false; });
  }

  loginRequest(username: string, password: string): Promise<string> {
    return axios
      .post(`${this.URL}/admin/login`, {
        username,
        password,
      })
      .then((r: AxiosResponse<{token: string}>) => {
        this.token = r.data.token;
        return this.token;
      });
  }

  getSchemasRequest(skip: number, limit: number) {
    return axios
      .get(`${this.URL}/admin/database/schemas`, { params: { skip, limit } })
      .then((r) => r.data);
  }

  getAdminModulesRequest() {
    return axios.get(`${this.URL}/admin/config/modules`).then(r => r.data);
  }

  getModuleConfig(module: string) {
    return axios.get(`${this.URL}/admin/config/${module}`).then(r => r.data.config);
  }

  getSecurityClients(): Promise<any[]> {
    if (!this.clientValidation.enabled) {
      throw new Error('Security Clients are disabled');
    }
    return axios.get(`${this.URL}/admin/security/client`).then(r => r.data.clients);
  }

  async createSecurityClient() {
    if (!this.clientValidation.enabled) {
      throw new Error('Security Clients are disabled');
    }
    return axios.post(
      `${this.URL}/admin/security/client`,
      {
        platform: 'LINUX', // We should add a 'CLI' platform
        alias: 'CLI',
        notes: 'Conduit CLI Test Client',
      },
    ).then((r) => r.data);
  }
}
