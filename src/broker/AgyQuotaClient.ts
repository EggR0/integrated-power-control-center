import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as cp from 'child_process';

const API_BASE = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

export interface QuotaToken {
  access_token: string;
  expiry: number;
}

export interface QuotaResult {
  quota: any;
  token: QuotaToken;
  account: string;
  fetchedAt: number;
}

export class AgyNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgyNotInstalledError';
  }
}

export class AgyNotAuthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgyNotAuthenticatedError';
  }
}

export class AgyQuotaClient {
  private extensionPath: string;

  constructor(extensionPath?: string) {
    this.extensionPath = extensionPath || path.resolve(__dirname, '..', '..');
  }

  private execFileAsync(file: string, args: string[], options: cp.ExecFileOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(file, args, options, (error, stdout, stderr) => {
        if (error) {
          (error as any).stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout.toString());
      });
    });
  }

  private findAgy(): string {
    const candidates = [
      process.env.AGY_PATH,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
    ].filter(Boolean) as string[];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new AgyNotInstalledError('agy.exe was not found. Install Antigravity CLI first.');
    }
    return found;
  }

  private async readCredential(): Promise<any> {
    const scriptCandidates = [
      path.join(this.extensionPath, 'scripts', 'read-agy-credential.ps1'),
      path.resolve(__dirname, '..', '..', 'scripts', 'read-agy-credential.ps1'),
      path.resolve(__dirname, '..', '..', '..', 'vscode-extension', 'scripts', 'read-agy-credential.ps1'),
    ];
    const script = scriptCandidates.find((c) => fs.existsSync(c)) || scriptCandidates[0];
    const stdout = await this.execFileAsync(
      'cmd.exe',
      ['/c', 'chcp', '65001', '>nul', '&&', 'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15000 }
    );
    const credential = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    if (!credential.token) {
      throw new AgyNotAuthenticatedError('The agy credential does not contain a token. Sign in to agy again.');
    }
    return credential;
  }

  private expiryEpoch(value: any): number {
    if (typeof value === 'number') {
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === 'string') {
      if (/^\d+$/.test(value)) return this.expiryEpoch(Number(value));
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    }
    return 0;
  }

  public tokenIsValid(token: any): boolean {
    return Boolean(token && token.access_token && this.expiryEpoch(token.expiry) > Math.floor(Date.now() / 1000) + 60);
  }

  private requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<any> {
    const { method = 'GET', headers = {}, body } = options;
    return new Promise((resolve, reject) => {
      const request = https.request(url, { method, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            reject(new Error(`The server returned invalid JSON (HTTP ${response.statusCode}).`));
            return;
          }
          if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
            const message = data.error && data.error.message ? data.error.message : text;
            reject(new Error(`Request failed (HTTP ${response.statusCode}): ${message}`));
            return;
          }
          resolve(data);
        });
      });
      request.setTimeout(15000, () => request.destroy(new Error('The quota request timed out.')));
      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
  }

  private clientSecretsFromBinary(agyPath: string): string[] {
    const binary = fs.readFileSync(agyPath).toString('latin1');
    return [...new Set(binary.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) || [])];
  }

  private async refreshAccessToken(refreshToken: string, agyPath: string): Promise<QuotaToken> {
    if (!refreshToken) throw new AgyNotAuthenticatedError('The agy credential has no refresh token. Sign in to agy again.');
    const secrets = this.clientSecretsFromBinary(agyPath);
    if (!secrets.length) throw new AgyNotAuthenticatedError('OAuth client information could not be read from the installed agy binary. Sign in to agy again.');

    let lastError: any;
    for (const secret of secrets) {
      const form = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString();
      try {
        const response = await this.requestJson(OAUTH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(form)),
          },
          body: form,
        });
        if (response.access_token) {
          return {
            access_token: response.access_token,
            expiry: Math.floor(Date.now() / 1000) + (response.expires_in || 3600),
          };
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw new AgyNotAuthenticatedError(lastError ? (lastError instanceof Error ? lastError.message : String(lastError.message || lastError)) : 'Failed to refresh the agy OAuth token. Sign in to agy again.');
  }

  private async agyVersion(agyPath: string): Promise<string> {
    try {
      const output = await this.execFileAsync(agyPath, ['--version'], {
        windowsHide: true,
        timeout: 10000,
      });
      const match = output.match(/\d+\.\d+\.\d+/);
      return match ? match[0] : '1.0.9';
    } catch {
      return '1.0.9';
    }
  }

  public async fetchQuota(cachedToken?: any): Promise<QuotaResult> {
    const agyPath = this.findAgy();
    const credential = await this.readCredential();
    let token = this.tokenIsValid(cachedToken) ? cachedToken : credential.token;
    if (!this.tokenIsValid(token)) {
      token = await this.refreshAccessToken(credential.token.refresh_token, agyPath);
    }

    const version = await this.agyVersion(agyPath);
    const userAgent = `antigravity/cli/${version} windows/amd64`;
    const headers = {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': userAgent,
    };

    const account = await this.requestJson(`${API_BASE}:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    });
    if (!account.cloudaicompanionProject) {
      throw new Error('Cloud Code did not return a quota project.');
    }

    const quota = await this.requestJson(`${API_BASE}:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project: account.cloudaicompanionProject }),
    });
    if (!Array.isArray(quota.groups)) {
      throw new Error('The quota response does not contain groups.');
    }

    return {
      quota,
      token,
      account: account.paidTier?.name || account.currentTier?.name || '',
      fetchedAt: Date.now(),
    };
  }
}
