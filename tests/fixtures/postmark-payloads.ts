/**
 * Sample Postmark webhook payloads for testing
 * Based on Postmark's webhook documentation
 */

export function createDeliveryPayload(messageId: string) {
  return {
    RecordType: "Delivery",
    MessageID: messageId,
    Recipient: "test@example.com",
    ServerID: 12345,
    MessageStream: "broadcast",
    DeliveredAt: new Date().toISOString(),
    Tag: "test-tag",
    Details: "Test delivery",
    Metadata: { source: "test" },
  };
}

export function createBouncePayload(id: number, messageId: string) {
  return {
    RecordType: "Bounce",
    ID: id,
    Type: "HardBounce",
    TypeCode: 1,
    Name: "Hard bounce",
    Tag: "test-tag",
    MessageID: messageId,
    ServerID: 12345,
    Description: "The email account does not exist",
    Details: "smtp;550 5.1.1 The email account that you tried to reach does not exist",
    Email: "bounced@example.com",
    From: "sender@test.com",
    BouncedAt: new Date().toISOString(),
    DumpAvailable: false,
    Inactive: true,
    CanActivate: false,
    Subject: "Test email",
    Content: "",
    MessageStream: "broadcast",
    Metadata: { source: "test" },
  };
}

export function createOpenPayload(messageId: string) {
  return {
    RecordType: "Open",
    MessageID: messageId,
    Recipient: "test@example.com",
    MessageStream: "broadcast",
    ReceivedAt: new Date().toISOString(),
    FirstOpen: true,
    Tag: "test-tag",
    Platform: "Desktop",
    ReadSeconds: 5,
    UserAgent: "Mozilla/5.0",
    OS: { Name: "Windows", Family: "Windows" },
    Client: { Name: "Chrome", Company: "Google" },
    Geo: { CountryISOCode: "US", Country: "United States", City: "New York" },
    Metadata: { source: "test" },
  };
}

export function createClickPayload(messageId: string) {
  return {
    RecordType: "Click",
    MessageID: messageId,
    Recipient: "test@example.com",
    MessageStream: "broadcast",
    ReceivedAt: new Date().toISOString(),
    Tag: "test-tag",
    ClickLocation: "HTML",
    OriginalLink: "https://example.com/cta",
    Platform: "Desktop",
    UserAgent: "Mozilla/5.0",
    OS: { Name: "Windows", Family: "Windows" },
    Client: { Name: "Chrome", Company: "Google" },
    Geo: { CountryISOCode: "US", Country: "United States", City: "New York" },
    Metadata: { source: "test" },
  };
}

export function createSpamComplaintPayload(messageId: string) {
  return {
    RecordType: "SpamComplaint",
    MessageID: messageId,
    ServerID: 12345,
    MessageStream: "broadcast",
    Tag: "test-tag",
    Email: "complainer@example.com",
    From: "sender@test.com",
    BouncedAt: new Date().toISOString(),
    Subject: "Test email",
    Metadata: { source: "test" },
  };
}

export function createSubscriptionChangePayload(messageId: string) {
  return {
    RecordType: "SubscriptionChange",
    MessageID: messageId,
    ServerID: 12345,
    MessageStream: "broadcast",
    Tag: "test-tag",
    Recipient: "unsubscriber@example.com",
    Origin: "Recipient",
    SuppressSending: true,
    ChangedAt: new Date().toISOString(),
    Metadata: { source: "test" },
  };
}

export function createInvalidPayload() {
  return {
    // Missing RecordType
    MessageID: "test-id",
    Recipient: "test@example.com",
  };
}
