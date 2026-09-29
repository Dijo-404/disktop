export type OperationFailureCode =
  | "permission-denied"
  | "unsupported"
  | "changed-target"
  | "protected-path"
  | "incomplete-scan"
  | "cancelled"
  | "invalid-plan";

export interface OperationFailure {
  readonly code: OperationFailureCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string>>;
}
