export interface ApplicationDetail {
  id: string;
  applicationNumber: string | null;
  status: string;
  version: number;
  form: Record<string, Record<string, unknown>>;
  createdAt: string;
  submittedAt: string | null;
  withdrawnAt: string | null;
  decisionDueDate: string | null;
  documents: { id: string; docType: string; originalName: string; mimeType: string; sizeBytes: number; uploadedAt: string }[];
  timeline: { fromStatus: string | null; toStatus: string; actorType: string; note: string | null; at: string }[];
  requiredDocuments: string[];
}
