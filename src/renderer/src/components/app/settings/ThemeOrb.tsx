import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";
import { themeOrbStyle, type ThemeOrbColors } from "../../../themes/t3Themes";
import { cn } from "../../../lib/utils";

/** Animate pigments inside a stationary T3 silhouette; pause when not visible. */
export function ThemeOrb({ colors, mode, phase = 0 }: { colors: ThemeOrbColors; mode: "light" | "dark"; phase?: number }) {
	const ref = useRef<HTMLSpanElement>(null);
	const inView = useInView(ref);
	const [visible, setVisible] = useState(() => !document.hidden);
	useEffect(() => {
		const update = () => setVisible(!document.hidden);
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return (
		<span
			ref={ref}
			aria-hidden="true"
			data-theme-orb={mode}
			className={cn("relative block shrink-0 overflow-hidden rounded-full", mode === "light" ? "size-[52px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.10),0_1px_2px_rgb(0_0_0/0.08)]" : "-ml-2.5 mt-4 size-[42px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.18)]")}
		>
			<span
				className="absolute inset-0 -z-0 rounded-full motion-safe:animate-[theme-orb-flow_14s_linear_infinite] motion-reduce:animate-none"
				style={{ ...themeOrbStyle(colors, mode), transform: "scale(1.1)", animationDelay: `${-phase}s`, animationDirection: mode === "dark" ? "reverse" : "normal", animationPlayState: inView && visible ? "running" : "paused" }}
			/>
		</span>
	);
}
