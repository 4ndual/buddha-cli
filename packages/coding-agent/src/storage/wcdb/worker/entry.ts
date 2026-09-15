import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { WcdbWorkerInbound, WcdbWorkerOutbound, WcdbWorkerTransport } from "./protocol";
import { createNativeWcdbAdapter } from "./native-adapter";
import { WcdbWorkerServer } from "./server";

/** Start the dedicated WCDB worker after explicit `db` mode selected it. */
export async function runWcdbWorker(): Promise<void> {
	if (!parentPort) throw new Error("WCDB worker entry requires a parent port");
	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: WcdbWorkerTransport = {
		send(message: WcdbWorkerOutbound) {
			port.postMessage(message);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(data => handler(data as WcdbWorkerInbound));
			const listener = (data: unknown): void => handler(data as WcdbWorkerInbound);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			try {
				port.close();
			} finally {
				setTimeout(() => process.exit(0), 0);
			}
		},
	};
	new WcdbWorkerServer(transport, createNativeWcdbAdapter);
}

if (import.meta.main) await runWcdbWorker();
