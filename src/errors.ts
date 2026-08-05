export class AgentSdkError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'AgentSdkError'
  }
}

export class UnsafeResourceUrlError extends AgentSdkError {
  constructor(message: string) {
    super(message, 'unsafe_resource_url')
    this.name = 'UnsafeResourceUrlError'
  }
}

export class CrossOriginRedirectError extends AgentSdkError {
  constructor() {
    super('cross-origin redirects are not allowed', 'cross_origin_redirect')
    this.name = 'CrossOriginRedirectError'
  }
}

export class PaidRequestRedirectError extends AgentSdkError {
  constructor() {
    super('a paid request returned a redirect; settlement is unknown', 'paid_request_redirect')
    this.name = 'PaidRequestRedirectError'
  }
}

export class ResourceRequestTimeoutError extends AgentSdkError {
  constructor() {
    super('resource request timed out', 'resource_request_timeout')
    this.name = 'ResourceRequestTimeoutError'
  }
}

export class ResourceResponseTooLargeError extends AgentSdkError {
  constructor() {
    super('resource response exceeded the configured size limit', 'resource_response_too_large')
    this.name = 'ResourceResponseTooLargeError'
  }
}

export class X402ProtocolError extends AgentSdkError {
  constructor(message: string, cause?: unknown) {
    super(message, 'invalid_x402_response', cause)
    this.name = 'X402ProtocolError'
  }
}

export class ControlApiError extends AgentSdkError {
  constructor(
    message: string,
    readonly status: number,
    readonly responseCode?: string,
  ) {
    super(message, 'control_api_error')
    this.name = 'ControlApiError'
  }
}

export class SidecarError extends AgentSdkError {
  constructor(message: string, cause?: unknown) {
    super(message, 'sidecar_error', cause)
    this.name = 'SidecarError'
  }
}

export class SettlementUnknownError extends AgentSdkError {
  constructor(
    readonly intentId: string,
    readonly authorizationId: string,
    cause?: unknown,
  ) {
    super(
      'the paid request did not produce a reliable response; do not create a new authorization',
      'settlement_unknown',
      cause,
    )
    this.name = 'SettlementUnknownError'
  }
}
