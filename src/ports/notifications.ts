export interface NotificationOutcome {
  readonly sent: boolean;
  readonly explanation: string;
}

export interface NotificationPort {
  readonly id: string;
  send(title: string, body: string): Promise<NotificationOutcome>;
}
