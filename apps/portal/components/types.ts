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
  correction: { items: string[]; message: string; at: string; open: boolean } | null;
  inspections: { id: string; status: string; scheduledFor: string; location: string; certificateNo: string | null; validUntil: string | null; countersigned: boolean }[];
  invoice: {
    invoiceNo: string;
    status: string;
    totalBdt: number;
    lines: { service: string; amountBdt: number; legalRef: string }[];
    payments: { method: string; reference: string; amountBdt: number; status: string; receiptNo: string | null; at: string }[];
  } | null;
  decision: { decision: string; reasons: string[]; reasonText: string | null; at: string } | null;
  appealDeadline: string | null;
  rejectionFinal: boolean;
  canAppeal: boolean;
  appeal: { status: string; grounds: string; filedAt: string; decidedAt: string | null; decisionNote: string | null } | null;
  registration: {
    id: string;
    plateSystemId: string;
    plateTextBn: string;
    registeredOn: string;
    validUntil: string;
    endOfLifeOn: string;
    status: string;
    zone: { code: string; nameBn: string; nameEn: string; uiColour: string; plateBackgroundColour: string };
    qr: { version: number; url: string; qrDataUrl: string } | null;
  } | null;
}
