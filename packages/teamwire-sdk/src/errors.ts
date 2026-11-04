export class TeamwireError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedAuthError extends TeamwireError {
  constructor(message = 'This server did not establish a supported Teamwire password session.') {
    super(message, 'UNSUPPORTED_AUTH');
  }
}

export class TeamwireProtocolError extends TeamwireError {
  constructor(message: string) { super(message, 'PROTOCOL_ERROR'); }
}

export class TeamwireHttpError extends TeamwireError {
  constructor(readonly status: number, readonly method: string, readonly endpoint: string) {
    super(`Teamwire ${method} request failed (HTTP ${status}).`, 'HTTP_ERROR');
  }
}

export class TeamwireSessionClosedError extends TeamwireError {
  constructor() { super('The Teamwire session is closed.', 'SESSION_CLOSED'); }
}

export class TeamwireUnsupportedConversationError extends TeamwireError {
  constructor() { super('This conversation does not support sending with this SDK.', 'UNSUPPORTED_CONVERSATION'); }
}
