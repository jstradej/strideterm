export interface NotificationPayload {
  title: string;
  body: string;
  sessionId?: string;
  workspaceId?: string;
  silent?: boolean;
}

export interface Toast {
  id: string;
  type: "info" | "success" | "warning" | "error";
  message: string;
  duration?: number;
  createdAt: string;
}

export interface Alert {
  id: string;
  sessionId: string;
  workspaceId: string;
  kind: "prompt" | "agent-idle" | "agent-done" | "task-done";
  message: string;
  createdAt: string;
}
