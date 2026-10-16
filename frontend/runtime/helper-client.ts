export type HelperConnection = { endpoint: string; token: string };
type HelperRequest = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

export class HelperConnectionError extends Error {
  readonly result: string;

  constructor(result: string) {
    super(result);
    this.result = result;
  }
}

/** 同一辅助进程的调用者共享连接；失效后统一重新发现，不自动重放有副作用的请求。 */
export class HelperClient {
  private connection: HelperConnection | null = null;
  private pending: Promise<HelperConnection> | null = null;
  private generation = 0;
  private readonly discover: () => Promise<string>;
  private readonly restart: () => Promise<string>;
  private readonly send: typeof fetch;

  constructor(discover: () => Promise<string>, restart = discover, send: typeof fetch = fetch) {
    this.discover = discover;
    this.restart = restart;
    // Window.fetch 必须以浏览器全局对象为 this，不能作为客户端实例的方法调用。
    this.send = send.bind(globalThis);
  }

  peek(): HelperConnection | null {
    return this.connection;
  }

  invalidate(expected = this.connection): void {
    if (expected !== this.connection) return;
    this.generation++;
    this.connection = null;
    this.pending = null;
  }

  connect(restart = false): Promise<HelperConnection> {
    if (restart) this.invalidate();
    if (this.connection) return Promise.resolve(this.connection);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = (async () => {
      const result = await (restart ? this.restart() : this.discover());
      if (generation !== this.generation) throw new Error("辅助进程连接已失效");
      const separator = result.lastIndexOf("|");
      if (separator <= 0 || separator === result.length - 1) throw new HelperConnectionError(result);
      const connection = { endpoint: result.slice(0, separator), token: result.slice(separator + 1) };
      this.connection = connection;
      return connection;
    })();
    this.pending = pending;
    const clear = () => { if (this.pending === pending) this.pending = null; };
    void pending.then(clear, clear);
    return pending;
  }

  async request(path: string, options: HelperRequest = {}, connection?: HelperConnection): Promise<Response> {
    const current = connection ?? await this.connect();
    try {
      const response = await this.send(`${current.endpoint}${path}`, {
        ...options,
        headers: { ...options.headers, "X-NEMusic-Token": current.token },
      });
      if (response.status === 403) this.invalidate(current);
      return response;
    } catch (error) {
      if (!options.signal?.aborted) this.invalidate(current);
      throw error;
    }
  }
}
