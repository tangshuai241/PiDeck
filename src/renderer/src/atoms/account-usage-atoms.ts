/** One public snapshot for the bottom bar and its account manager. */
import { atom } from "jotai";
import type { QuotaSnapshot } from "../../../shared/types/accountUsage";
export const accountUsageSnapshotAtom = atom<QuotaSnapshot>({ accounts: [], results: {} });
