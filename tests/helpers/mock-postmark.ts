import { vi } from "vitest";

/**
 * Mock Postmark client for unit tests
 */
export const mockPostmarkClient = {
  sendEmail: vi.fn(),
  getOutboundMessageDetails: vi.fn(),
  getBounces: vi.fn(),
};

/**
 * Create a successful send response
 */
export function createSuccessSendResponse(messageId: string = "test-message-id") {
  return {
    To: "test@example.com",
    SubmittedAt: new Date().toISOString(),
    MessageID: messageId,
    ErrorCode: 0,
    Message: "OK",
  };
}

/**
 * Create a failed send response
 */
export function createFailedSendResponse(errorCode: number = 300, message: string = "Invalid email") {
  return {
    To: "test@example.com",
    SubmittedAt: new Date().toISOString(),
    MessageID: "",
    ErrorCode: errorCode,
    Message: message,
  };
}

/**
 * Reset all mocks
 */
export function resetMocks() {
  mockPostmarkClient.sendEmail.mockReset();
  mockPostmarkClient.getOutboundMessageDetails.mockReset();
  mockPostmarkClient.getBounces.mockReset();
}

/**
 * Setup mock to return success
 */
export function mockSendSuccess(messageId?: string) {
  mockPostmarkClient.sendEmail.mockResolvedValue(createSuccessSendResponse(messageId));
}

/**
 * Setup mock to return failure
 */
export function mockSendFailure(errorCode?: number, message?: string) {
  mockPostmarkClient.sendEmail.mockResolvedValue(createFailedSendResponse(errorCode, message));
}

/**
 * Setup mock to throw error
 */
export function mockSendError(error: Error) {
  mockPostmarkClient.sendEmail.mockRejectedValue(error);
}
