export type AgentNavRecord = {
  id: string;
  name: string;
  description: string;
  iconKey: string;
};

export type AgentChatRecord = {
  id: string;
  name: string;
};

export type AgentConfigRowForUI = {
  id: string;
  name: string;
  description: string;
  model: string | null;
  enabledTools: string[];
  userPromptTuning: string | null;
  preferredSourceUrls: string[];
};

