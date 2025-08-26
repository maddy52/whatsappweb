// lovable-client.ts
// Minimal TypeScript client for the WhatsApp Sender Gateway
export interface StatusResponse {
  ready: boolean;
  qrAvailable: boolean;
  lastError: string | null;
}

export interface SendOK {
  ok: boolean;
  id: string | null;
  to: string;
}

export class WhatsAppGateway {
  constructor(private baseUrl: string, private apiKey: string) {}

  private headers(json = true): HeadersInit {
    const h: Record<string,string> = { 'x-api-key': this.apiKey };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async createSession(trainerId: string) {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ trainerId }),
    });
    if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
    return res.json();
  }

  async getStatus(trainerId: string): Promise<StatusResponse> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(trainerId)}/status`, {
      headers: this.headers(false),
    });
    if (!res.ok) throw new Error(`getStatus failed: ${res.status}`);
    return res.json();
  }

  getQrUrl(trainerId: string): string {
    return `${this.baseUrl}/sessions/${encodeURIComponent(trainerId)}/qr`;
  }

  async send(trainerId: string, to: string, text: string): Promise<SendOK> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(trainerId)}/send`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`send failed: ${res.status} ${err}`);
    }
    return res.json();
  }

  async logout(trainerId: string) {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(trainerId)}/logout`, {
      method: 'POST',
      headers: this.headers(false),
    });
    if (!res.ok) throw new Error(`logout failed: ${res.status}`);
    return res.json();
  }

  async deleteSession(trainerId: string, purge = false) {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(trainerId)}?purge=${purge}`, {
      method: 'DELETE',
      headers: this.headers(false),
    });
    if (!res.ok) throw new Error(`deleteSession failed: ${res.status}`);
    return res.json();
  }

  async listSessions() {
    const res = await fetch(`${this.baseUrl}/sessions`, { headers: this.headers(false) });
    if (!res.ok) throw new Error(`listSessions failed: ${res.status}`);
    return res.json();
  }
}
