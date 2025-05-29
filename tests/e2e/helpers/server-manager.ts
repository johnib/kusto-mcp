import { ChildProcess, spawn } from 'child_process';
import { E2E_TEST_CONFIG, getTestEnv } from '../config.js';

/**
 * Manages the lifecycle of MCP server subprocess for testing
 */
export class ServerManager {
  private process: ChildProcess | null = null;
  private logs: string[] = [];

  /**
   * Spawn the MCP server as a subprocess
   */
  async spawnServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server failed to start within timeout'));
      }, E2E_TEST_CONFIG.serverTimeout);

      try {
        this.process = spawn(
          'node',
          [E2E_TEST_CONFIG.serverBinary, ...E2E_TEST_CONFIG.serverArgs],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...getTestEnv() },
          },
        );

        this.setupServerLogging(this.process);

        // Wait for server to be ready (look for startup message)
        const onStdoutData = (data: Buffer) => {
          const message = data.toString();
          if (message.includes('Kusto MCP Server running on stdio')) {
            clearTimeout(timeout);
            this.process!.stdout!.off('data', onStdoutData);
            this.process!.stderr!.off('data', onStderrData);
            resolve(this.process!);
          }
        };

        const onStderrData = (data: Buffer) => {
          const message = data.toString();
          if (message.includes('Kusto MCP Server running on stdio')) {
            clearTimeout(timeout);
            this.process!.stdout!.off('data', onStdoutData);
            this.process!.stderr!.off('data', onStderrData);
            resolve(this.process!);
          }
        };

        this.process.stdout!.on('data', onStdoutData);
        this.process.stderr!.on('data', onStderrData);

        this.process.on('error', error => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn server: ${error.message}`));
        });

        this.process.on('exit', code => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout);
            reject(new Error(`Server exited with code ${code}`));
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Setup logging for the server process
   */
  setupServerLogging(serverProcess: ChildProcess): void {
    if (serverProcess.stdout) {
      serverProcess.stdout.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        this.logs.push(`[STDOUT] ${message}`);

        // Log server messages in test output for debugging
        if (process.env.NODE_ENV === 'test' && process.env.DEBUG_SERVER) {
          console.log(`[SERVER STDOUT] ${message}`);
        }
      });
    }

    if (serverProcess.stderr) {
      serverProcess.stderr.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        this.logs.push(`[STDERR] ${message}`);

        // Log server stderr messages in test output for debugging
        if (process.env.NODE_ENV === 'test' && process.env.DEBUG_SERVER) {
          console.log(`[SERVER STDERR] ${message}`);
        }
      });
    }
  }

  /**
   * Kill the server process
   */
  async killServer(): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        resolve();
      });

      // Try graceful shutdown first
      this.process!.kill('SIGTERM');
    });
  }

  /**
   * Get server process
   */
  getProcess(): ChildProcess | null {
    return this.process;
  }

  /**
   * Get server logs
   */
  getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Clear logs
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
