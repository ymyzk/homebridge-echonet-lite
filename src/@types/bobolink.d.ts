// Minimal hand-written declarations for bobolink (no bundled or
// DefinitelyTyped types). Only the surface consumed by this plugin is typed.
declare module "bobolink" {
  // Bobolink resolves (never rejects) `put` with this state object;
  // `err === undefined` means the task succeeded.
  export interface TaskState<T> {
    err?: unknown;
    res: T | null;
    waitingTime: number;
    runTime: number;
    retry: number;
  }

  export default class Bobolink {
    constructor(options?: { concurrency?: number; timeout?: number; [key: string]: unknown });
    put<T>(task: () => Promise<T>): Promise<TaskState<T>>;
  }
}
