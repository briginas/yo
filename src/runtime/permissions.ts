export type PermissionDeniedReason =
  | "outside_workspace"
  | "read_only_policy"
  | "unknown_tool";

export type PermissionDecision =
  | {
      decision: "allow";
    }
  | {
      decision: "deny";
      reason: PermissionDeniedReason;
    };
