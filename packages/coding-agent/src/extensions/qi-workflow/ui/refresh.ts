import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { WorkflowController } from "../controller.ts";
import type { QiWorkflowState } from "../domain/index.ts";
import { refreshFooter } from "./footer.ts";
import { refreshBoard } from "./work-board.ts";

export type QiUiHost = { ui: Pick<ExtensionUIContext, "setWidget" | "setStatus"> };

/** Refresh board + footer together from current controller state. */
export function refreshQiUi(ctx: QiUiHost, controller: WorkflowController): void {
	refreshBoard(ctx, controller);
	refreshFooter(ctx, controller.getState());
}

/** Subscribe to controller state and keep board + footer in sync. Returns unsubscribe. */
export function subscribeQiUi(ctx: QiUiHost, controller: WorkflowController): () => void {
	refreshQiUi(ctx, controller);
	return controller.subscribe((_state: QiWorkflowState) => {
		refreshQiUi(ctx, controller);
	});
}

export { refreshBoard, refreshFooter };
