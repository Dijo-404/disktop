export interface NotificationPort {
  readonly id: string;
  available(): Promise<boolean>;
  send(title: string, body: string): Promise<void>;
}
