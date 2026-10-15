import source from "./reference-assets/github-mark.png";
import { cn } from "@/lib/utils";

/** Official GitHub mark for the GitHub option shown in the user's reference. */
export function GitHubMark({ className }: { className?: string; strokeWidth?: number; fill?: string }) {
	return <img src={source} alt="" aria-hidden="true" className={cn("size-[18px] mix-blend-multiply opacity-60", className)} />;
}
