type LevelError = {
  code: string;
  notFound: boolean;
  status: number;
};

type RetryRecord = {
  attempts: number;
  retry: string;
};

type DoneRecord = {
  done: boolean;
  status: string;
  date: number;
}

export { LevelError, RetryRecord, DoneRecord };
