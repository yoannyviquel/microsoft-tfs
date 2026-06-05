export const ICON = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  key: '🔑',
  list: '📋',
  state: '📊',
  tag: '🏷️',
  bolt: '⚡',
  user: '👤',
  edit: '📝',
  calendar: '📅',
  refresh: '🔄',
  link: '🔗',
  branchSource: '🌿',
  branchTarget: '🎯',
  flag: '🏁',
  lock: '🔒',
  merge: '🔀',
  reviewers: '👥',
};

export function getChangeTypeIcon(changeType: string | undefined): string {
  switch ((changeType ?? '').toLowerCase()) {
    case 'add': return '✅';
    case 'edit': return '✏️';
    case 'delete': return '❌';
    case 'rename': return '🔄';
    case 'merge': return '🔀';
    case 'copy': return '📋';
    case 'move': return '📦';
    case 'branch': return '🌿';
    case 'undelete': return '♻️';
    default: return '📄';
  }
}
