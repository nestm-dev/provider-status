import {
	Controller,
	Get,
	Header,
	NotFoundException,
	Param,
	Sse,
	type MessageEvent,
} from "@nestjs/common";
import { interval, map, merge, type Observable } from "rxjs";
import { ProviderStatusService } from "../provider-status.service.ts";
import type {
	ProviderStatusHealth,
	ProviderStatusSnapshot,
	ProviderStatusWarning,
} from "../core/index.ts";

@Controller("provider-status")
export class ProviderStatusHttpController {
	constructor(private readonly providerStatus: ProviderStatusService) {}

	@Get()
	@Header("Cache-Control", "no-store")
	getSnapshot(): ProviderStatusSnapshot {
		return this.providerStatus.getSnapshot();
	}

	@Get("warnings")
	@Header("Cache-Control", "no-store")
	getWarnings(): readonly ProviderStatusWarning[] {
		return this.providerStatus.getSnapshot().warnings;
	}

	@Sse("stream")
	stream(): Observable<MessageEvent> {
		const snapshots = this.providerStatus.status$.pipe(
			map((snapshot): MessageEvent => ({
				type: "provider-status",
				id: snapshot.computedAt,
				data: snapshot,
				retry: 5_000,
			})),
		);
		const heartbeat = interval(15_000).pipe(
			map((): MessageEvent => ({
				type: "provider-status-heartbeat",
				data: { at: new Date().toISOString() },
			})),
		);
		return merge(snapshots, heartbeat);
	}

	@Get(":providerId")
	@Header("Cache-Control", "no-store")
	getProvider(@Param("providerId") providerId: string): ProviderStatusHealth {
		const health = this.providerStatus.get(providerId);
		if (health) return health;
		throw new NotFoundException(`Unknown provider status id "${providerId}".`);
	}
}
