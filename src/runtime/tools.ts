export type ToolName = "list_files" | "search_code" | "read_file";

export type ToolCall = {
  id: string;
  name: ToolName;
  arguments: unknown;
};

export type ToolResultStatus =
  | "success"
  | "invalid_arguments"
  | "unknown_tool"
  | "denied"
  | "timeout"
  | "execution_error"
  | "aborted";

export type ToolResultMetadata = {
  truncated: boolean;
  truncation: ToolResultTruncation | null;
};

export type ToolResultTruncation = {
  reason: "byte_limit" | "line_limit" | "result_limit";
  limit: number;
  observed: number;
};

export type ToolError = {
  code: string;
  message: string;
};

export type ToolResult =
  | {
      status: Extract<ToolResultStatus, "success">;
      callId: string;
      content: string;
      metadata: ToolResultMetadata;
    }
  | {
      status: Exclude<ToolResultStatus, "success">;
      callId: string;
      content: string;
      metadata: ToolResultMetadata;
      error: ToolError;
    };
