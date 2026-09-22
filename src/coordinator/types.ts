export type CoordinatorAction =
  | {
      action: "retrieve";
      query: string;
    }
  | {
      action: "respond";
      message: string;
    };
