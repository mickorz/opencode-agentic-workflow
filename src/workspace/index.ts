/**
 * Workspace 公共出口（P2.7）
 */

export type {
  WorkspaceHandle,
  WorkspaceIdentity,
  WorkspaceOptions,
  WorkspaceProvider,
  CleanupPolicy,
} from "./provider.js"
export { GitWorktreeProvider, type GitWorktreeProviderOptions } from "./git-worktree.js"
export {
  InPlaceWorkspaceProvider,
  type InPlaceWorkspaceProviderOptions,
} from "./in-place.js"
export { currentWorkspace, setCurrentWorkspace } from "./ambient.js"
