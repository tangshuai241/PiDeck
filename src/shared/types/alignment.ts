/** The bounded, versioned brief exchanged through pi's existing RPC messages. */
export type AlignmentBrief = {
	goal: string;
	scope: string[];
	materials: string[];
	deliverable: string;
	preserve: string[];
	acceptance: string[];
	questions: string[];
};

export type AlignmentPhase = "clarifying" | "ready" | "approved" | "cancelled" | "complete";

/** Approval belongs to one exact brief revision, never to a whole session. */
export type AlignmentState = {
	schemaVersion: 1;
	briefId: string;
	revision: number;
	phase: AlignmentPhase;
	brief?: AlignmentBrief;
	/** Revision at which alignment_brief published these fields; input invalidation retains this stamp. */
	briefRevision?: number;
	/** A stopped clarification needs continuation, never a false complete/progress signal. */
	lastStopReason?: "aborted" | "error";
};
