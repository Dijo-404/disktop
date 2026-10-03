/** Account names by numeric user id. Empty when they could not be read. */
export interface AccountNamesPort {
  names(): Promise<ReadonlyMap<bigint, string>>;
}
