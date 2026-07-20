import type { PermissionDecision } from "./permissions";
import type { ToolCall, ToolName, ToolResult } from "./tools";

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "failed";

export type StopReason =
  | "final_answer"
  | "step_budget_exhausted"
  | "aborted"
  | "transport_error";

export type RunBudget = {
  maxSteps: number;
  perToolTimeoutMs: number;
};

export type ModelRequestMetadata = {
  model: string | null;
  visibleTools: ToolName[];
};

export type ModelResponseMetadata = {
  model: string | null;
  toolCallCount: number;
  hasFinalAnswer: boolean;
};

export type RunEvent =
  | {
      type: "run_started";
      task: string;
      workspaceRoot: string;
      budget: RunBudget;
    }
  | {
      type: "model_requested";
      step: number;
      metadata: ModelRequestMetadata;
    }
  | {
      type: "model_responded";
      step: number;
      metadata: ModelResponseMetadata;
    }
  | {
      type: "tool_requested";
      step: number;
      call: ToolCall;
    }
  | {
      type: "tool_authorized";
      step: number;
      callId: string;
      decision: PermissionDecision;
    }
  | {
      type: "tool_completed";
      step: number;
      result: ToolResult;
    }
  | {
      type: "final_answer";
      answer: string;
    }
  | {
      type: "run_finished";
      status: Exclude<RunStatus, "pending" | "running">;
      reason: StopReason;
    };

export type SessionMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
    }
  | {
      role: "tool";
      result: ToolResult;
    };

export type SessionState = {
  task: string;
  workspaceRoot: string;
  budget: RunBudget;
  status: RunStatus;
  stepCount: number;
  messages: SessionMessage[];
  events: RunEvent[];
  finalAnswer: string | null;
  stopReason: StopReason | null;
};
