import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { WorkflowController } from "../controller.ts";
import type { QiWorkflowState } from "../domain/index.ts";
import { footerNeedsAnimation, refreshFooter } from "./footer.ts";
import { refreshBoard } from "./work-board.ts";

export type QiUiHost = { ui: Pick<ExtensionUIContext, "setWidget" | "setStatus"> };

const ANIM_MS = 120;

/** Refresh board + footer together from current controller state. */
export function refreshQiUi(ctx: QiUiHost, controller: WorkflowController, tick = 0): void {
	refreshBoard(ctx, controller);
	refreshFooter(ctx, controller.getState(), tick);
}

/** Subscribe to controller state and keep board + footer in sync. Returns unsubscribe. */
export function subscribeQiUi(ctx: QiUiHost, controller: WorkflowController): () => void {
	let tick = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopAnim = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const syncAnim = (state: QiWorkflowState) => {
		if (footerNeedsAnimation(state)) {
			if (!timer) {
				timer = setInterval(() => {
					tick += 1;
					refreshFooter(ctx, controller.getState(), tick);
				}, ANIM_MS);
				if (typeof timer === "object" && "unref" in timer) {
					(timer as NodeJS.Timeout).unref?.();
				}
			}
		} else {
			stopAnim();
			tick = 0;
		}
	};

	refreshQiUi(ctx, controller, tick);
	syncAnim(controller.getState());

	const unsub = controller.subscribe((state: QiWorkflowState) => {
		refreshQiUi(ctx, controller, tick);
		syncAnim(state);
	});

	return () => {
		unsub();
		stopAnim();
	};
}

export { refreshBoard, refreshFooter };
