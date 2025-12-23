import { ChildProcess } from 'child_process';
import { ServerManager } from './server-manager.js';

/**
 * JSON-RPC message types for MCP protocol
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

/**
 * MCP Test Client for communicating with the server subprocess
 */
export class MCPTestClient {
  private serverManager: ServerManager;
  private serverProcess: ChildProcess | null = null;
  private messageId: number = 1;
  private pendingRequests: Map<
    string | number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();
  private isInitialized: boolean = false;

  constructor() {
    this.serverManager = new ServerManager();
  }

  /**
   * Start the MCP server and initialize the connection
   */
  async startServer(): Promise<void> {
    this.serverProcess = await this.serverManager.spawnServer();
    this.setupMessageHandling();
    await this.initializeSession();
    this.isInitialized = true;
  }

  /**
   * Stop the MCP server
   */
  async stopServer(): Promise<void> {
    this.isInitialized = false;

    // Cancel all pending requests
    Array.from(this.pendingRequests.entries()).forEach(([id, request]) => {
      clearTimeout(request.timeout);
      request.reject(new Error('Server stopped'));
    });
    this.pendingRequests.clear();

    await this.serverManager.killServer();
    this.serverProcess = null;
  }

  /**
   * Setup message handling for JSON-RPC communication
   */
  private setupMessageHandling(): void {
    if (!this.serverProcess || !this.serverProcess.stdout) {
      throw new Error('Server process not available');
    }

    let buffer = '';

    this.serverProcess.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();

      // Process complete JSON-RPC messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            const message = JSON.parse(trimmed);
            this.handleMessage(message);
          } catch (error) {
            console.error('Failed to parse JSON-RPC message:', trimmed, error);
          }
        }
      }
    });
  }

  /**
   * Handle incoming JSON-RPC messages
   */
  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    // Handle responses to our requests
    if ('id' in message) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(`JSON-RPC Error: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
    // Handle notifications (if any)
    else {
      console.log('Received notification:', message.method, message.params);
    }
  }

  /**
   * Initialize the MCP session
   */
  private async initializeSession(): Promise<void> {
    // Send initialize request
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: 'kusto-mcp-test-client',
        version: '1.0.0',
      },
    });

    // Send initialized notification
    await this.sendNotification('initialized', {});
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  private async sendRequest(method: string, params?: any): Promise<any> {
    if (!this.serverProcess || !this.serverProcess.stdin) {
      throw new Error('Server process not available');
    }

    const id = this.messageId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000); // 30 second timeout

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const message = JSON.stringify(request) + '\n';
      this.serverProcess!.stdin!.write(message);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private async sendNotification(method: string, params?: any): Promise<void> {
    if (!this.serverProcess || !this.serverProcess.stdin) {
      throw new Error('Server process not available');
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const message = JSON.stringify(notification) + '\n';
    this.serverProcess.stdin.write(message);
  }

  /**
   * List available tools
   */
  async listTools(): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Client not initialized');
    }

    return await this.sendRequest('tools/list', {});
  }

  /**
   * Call a specific tool
   */
  async callTool(name: string, arguments_: any = {}): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Client not initialized');
    }

    return await this.sendRequest('tools/call', {
      name,
      arguments: arguments_,
    });
  }

  /**
   * List available prompts
   */
  async listPrompts(cursor?: string): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Client not initialized');
    }

    return await this.sendRequest('prompts/list', cursor ? { cursor } : {});
  }

  /**
   * Get a specific prompt
   */
  async getPrompt(name: string, arguments_: Record<string, string> = {}): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Client not initialized');
    }

    return await this.sendRequest('prompts/get', {
      name,
      arguments: arguments_,
    });
  }

  /**
   * Get server logs for debugging
   */
  getServerLogs(): string[] {
    return this.serverManager.getLogs();
  }

  /**
   * Check if client is connected and initialized
   */
  isConnected(): boolean {
    return this.isInitialized && this.serverManager.isRunning();
  }
}
