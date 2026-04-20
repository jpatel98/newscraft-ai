export type TenantPath = {
  orgSlug: string;
  workspaceSlug: string;
};

export function tenantBasePath(path: TenantPath) {
  return `/o/${path.orgSlug}/w/${path.workspaceSlug}`;
}

export function tenantChannelPath(path: TenantPath, channelSlug: string) {
  return `${tenantBasePath(path)}/channel/${channelSlug}`;
}

export function tenantAgentPath(path: TenantPath, agentId: string) {
  return `${tenantBasePath(path)}/agent/${agentId}`;
}
