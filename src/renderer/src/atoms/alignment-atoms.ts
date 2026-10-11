import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

/** One in-flight alignment control per session, including split views of the same session. */
export const alignmentControlPendingAtomFamily = atomFamily((_sessionId: string) => atom(false));
