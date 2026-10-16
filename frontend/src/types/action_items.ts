export interface ResolvedActionItem {
  id: string;
  meeting_id: string;
  project_id: string;
  meeting_title: string;
  meeting_date: string;
  task: string;
  due_date?: string | null; // YYYY-MM-DD
  due_phrase?: string | null;
  status: 'open' | 'in_progress' | 'done' | 'dropped';
  assignment_type?: 'delegated' | 'volunteered' | 'proposed_unconfirmed' | 'unassigned' | null;
  confidence?: number | null;
  start_seconds?: number | null;
  evidence_turn_ids?: string[] | null;
  completed_at?: string | null;
  updated_at: string;
  created_at: string;
  assignee_speaker_id?: string | null;
  assigner_speaker_id?: string | null;
  assignee_person_id_resolved?: string | null;
  assignee_user_id?: string | null;
  assignee_label?: string | null;
  assigner_user_id?: string | null;
  assigner_label?: string | null;
  speaker_unresolved: boolean;
  user_edited: boolean;
}

export interface ActionItemsCount {
  open: number;
  needs_review: number;
  done: number;
}

export interface ListActionItemsResponse {
  items: ResolvedActionItem[];
  counts: ActionItemsCount;
}

export interface EvidenceTurnSnippet {
  id: string;
  speaker_name: string;
  text: string;
  timestamp: number;
}

export interface ActionItemEvidence {
  id: string;
  task: string;
  meeting_id: string;
  meeting_title: string;
  start_seconds?: number | null;
  turns: EvidenceTurnSnippet[];
}
