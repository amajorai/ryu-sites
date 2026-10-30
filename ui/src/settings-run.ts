export type Run = (work: () => Promise<void>) => Promise<void>;
