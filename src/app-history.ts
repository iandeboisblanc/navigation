import {
    AppHistoryEntry,
    AppHistoryEntryInit,
    AppHistoryEntryKnownAs,
    AppHistoryEntryNavigationType
} from "./app-history-entry";
import {
    AppHistory as AppHistoryPrototype,
    AppHistoryEventMap,
    AppHistoryNavigateOptions,
    AppHistoryNavigationOptions,
    AppHistoryReloadOptions,
    AppHistoryResult,
    AppHistoryUpdateCurrentOptions,
    AppHistoryTransition as AppHistoryTransitionPrototype
} from "./spec/app-history";
import {AppHistoryEventTarget} from "./app-history-event-target";
import {InvalidStateError} from "./app-history-errors";
import {Event, EventTargetListeners} from "./event-target";
import AbortController from "abort-controller";
import {AppHistoryTransition} from "./app-history-transition";
import {
    createAppHistoryTransition,
    InternalAppHistoryNavigationType,
    InternalAppHistoryNavigateOptions,
    Rollback,
    UpdateCurrent, Unset
} from "./create-app-history-transition";

export * from "./spec/app-history";

export class AppHistory extends AppHistoryEventTarget<AppHistoryEventMap> implements AppHistoryPrototype {

    // Should be always 0 or 1
    #transitionInProgressCount = 0;

    #entries: AppHistoryEntry[] = [];
    #known = new Set<AppHistoryEntry>();
    #currentIndex = -1;
    #activePromise?: Promise<AppHistoryEntry>;
    #activeTransition?: AppHistoryTransition;

    #inProgressAbortController?: AbortController;

    #knownTransitions = new WeakSet();

    get canGoBack() {
        if (this.#currentIndex === 0) {
            return false;
        }
        const previous = this.#entries[this.#currentIndex - 1];
        return !!previous;
    };

    get canGoForward() {
        if (this.#currentIndex === -1) {
            return false;
        }
        if (this.#currentIndex === this.#entries.length - 1) {
            return false;
        }
        const next = this.#entries[this.#currentIndex + 1];
        return !!next;
    };

    get current() {
        if (this.#currentIndex === -1) {
            return undefined;
        }
        return this.#entries[this.#currentIndex];
    };

    get transition(): AppHistoryTransitionPrototype | undefined {
        return this.#activeTransition;
    };

    back(options?: AppHistoryNavigationOptions): AppHistoryResult {
        if (!this.canGoBack) throw new InvalidStateError("Cannot go back");
        const entry = this.#entries[this.#currentIndex - 1];
        return this.#pushEntry("traverse", this.#cloneAppHistoryEntry(entry, {
            ...options,
            navigationType: "traverse"
        }));
    }

    entries(): AppHistoryEntry[] {
        return [...this.#entries];
    }

    forward(options?: AppHistoryNavigationOptions): AppHistoryResult {
        if (!this.canGoForward) throw new InvalidStateError();
        const entry = this.#entries[this.#currentIndex + 1];
        return this.#pushEntry("traverse", this.#cloneAppHistoryEntry(entry, {
            ...options,
            navigationType: "traverse"
        }));
    }

    goTo(key: string, options?: AppHistoryNavigationOptions): AppHistoryResult {
        const found = this.#entries.find(entry => entry.key === key);
        if (found) {
            return this.#pushEntry("traverse", this.#cloneAppHistoryEntry(found, {
                ...options,
                navigationType: "traverse"
            }));
        }
        throw new InvalidStateError();
    }

    navigate(url: string, options?: AppHistoryNavigateOptions): AppHistoryResult {
        const navigationType = options?.replace ? "replace" : "push";
        const entry = this.#createAppHistoryEntry({
            url,
            ...options,
            navigationType
        });
        return this.#pushEntry(
            navigationType,
            entry,
            undefined,
            options
        );
    }

    #cloneAppHistoryEntry = (entry?: AppHistoryEntry, options?: InternalAppHistoryNavigateOptions): AppHistoryEntry => {
        return this.#createAppHistoryEntry({
            ...entry,
            index: entry?.index ?? undefined,
            state: options?.state ?? entry?.getState(),
            navigationType: entry?.[AppHistoryEntryNavigationType] ?? (typeof options?.navigationType === "string" ? options.navigationType : "replace"),
            ...options,
            get [AppHistoryEntryKnownAs]() {
              return entry?.[AppHistoryEntryKnownAs];
            },
            get [EventTargetListeners]() {
                return entry?.[EventTargetListeners];
            }
        });
    }

    #createAppHistoryEntry = (options: Partial<AppHistoryEntryInit> & Omit<AppHistoryEntryInit, "index">) => {
        const entry: AppHistoryEntry = new AppHistoryEntry({
            ...options,
            index: options.index ?? (() => {
                return this.#entries.indexOf(entry);
            }),
        });
        return entry;

    }

    #pushEntry = (navigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry, transition?: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions) => {
        if (entry === this.current) throw new InvalidStateError();
        const existingPosition = this.#entries.findIndex(existing => existing.id === entry.id);
        if (existingPosition > -1) {
            throw new InvalidStateError();
        }
        return this.#commitTransition(navigationType, entry, transition, options);
    };

    #commitTransition = (givenNavigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry,  transition?: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions) => {
        let nextTransition: AppHistoryTransition | undefined = transition;
        const finished: Promise<AppHistoryEntry> = (this.#activePromise ?? Promise.resolve(entry))
            .catch((error) => void error) // Catch somewhere else please
            .then(async (): Promise<AppHistoryEntry> => {
                if (!nextTransition) {
                    throw new InvalidStateError("Expected transition to be available");
                }
                return this.#immediateTransition(givenNavigationType, entry, finished, nextTransition, options);
            });
        // finished.catch(error => void error);
        this.#activePromise = finished;
        nextTransition = new AppHistoryTransition({
            get finished() {
                return finished;
            },
            from: entry,
            navigationType: typeof givenNavigationType === "string" ? givenNavigationType : "replace",
            rollback: this.#createRollback(this.#pushEntry),
            then: this.#createActiveThen(entry),
        });
        this.#queueTransition(nextTransition);
        if (givenNavigationType !== UpdateCurrent) {
            this.#inProgressAbortController?.abort();
        }
        return { committed: Promise.resolve(entry), finished };
    }

    #queueTransition = (transition: AppHistoryTransition) => {
        // TODO consume errors that are not abort errors
        // transition.finished.catch(error => void error);
        this.#knownTransitions.add(transition);
    }

    #immediateTransition = async (givenNavigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry, finished: Promise<AppHistoryEntry>, transition: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions): Promise<AppHistoryEntry> => {
        try {
            this.#transitionInProgressCount += 1;
            if (this.#transitionInProgressCount > 1) {
                throw new InvalidStateError("Unexpected multiple transitions");
            }
            return await this.#transition(givenNavigationType, entry, transition, options);
        } finally {
            this.#transitionInProgressCount -= 1;
        }
    }

    #createRollback = (
        fn: (
            navigationType: InternalAppHistoryNavigationType,
            entry: AppHistoryEntry,
            transition?: AppHistoryTransition | undefined,
            options?: InternalAppHistoryNavigateOptions
        ) => (AppHistoryResult | Promise<AppHistoryEntry>),
        transition?: AppHistoryTransition
    ): (
        (options?: AppHistoryNavigationOptions) => AppHistoryResult
    ) => {
        const { current } = this;
        const previousEntries = [...this.#entries];
        const previousIndex = this.#currentIndex;
        const known = this.#known;
        return (options): AppHistoryResult => {
            // console.trace("Rollback !", { current, previousEntries, previousIndex, fn });
            const entry = current ? this.#cloneAppHistoryEntry(current, options) : undefined;
            const nextOptions: InternalAppHistoryNavigateOptions = {
                ...options,
                index: previousIndex,
                known,
                navigationType: entry?.[AppHistoryEntryNavigationType] ?? "replace",
                entries: previousEntries,
            } as const;
            const resolvedNavigationType = entry ? Rollback : Unset
            const resolvedEntry = entry ?? this.#createAppHistoryEntry({
                navigationType: "replace",
                index: nextOptions.index,
                sameDocument: true,
                ...options,
            });
            const result = fn(resolvedNavigationType, resolvedEntry, transition, nextOptions);
            if ("then" in result) {
                result.catch(error => void error);
                return { committed: Promise.resolve(resolvedEntry), finished: result };
            }
            return result;
        }
    }

    #createActiveThen = (entry: AppHistoryEntry): PromiseLike<AppHistoryEntry>["then"] => {
        return async (resolve, reject) => {
            const handler = async () => entry;
            while (this.#activePromise) {
                await this.#activePromise;
            }
            return handler().then(resolve, reject);
        }
    }

    #transition = async (givenNavigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry, transition?: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions): Promise<AppHistoryEntry> => {
        if (!transition) {
            throw new InvalidStateError("Expected transition");
        }

        let navigationType = givenNavigationType;

        const performance = await getPerformance();
        const startTime = performance.now();

        if (entry.sameDocument && typeof navigationType === "string") {
            performance.mark(`same-document-navigation:${entry.id}`);
        }

        const { current } = this;
        const abortController = new AbortController();
        this.#inProgressAbortController = abortController;
        let promises: Promise<unknown>[] = [];

        const rollbackImmediately = this.#createRollback(this.#transition);

        const currentTransition: AppHistoryTransition | undefined = new AppHistoryTransition({
            ...transition,
            rollback: this.#createRollback(this.#pushEntry),
            then: this.#createActiveThen(entry)
        });

        const completeTransition = async (): Promise<AppHistoryEntry> => {
            if (givenNavigationType === Unset && typeof options?.index === "number" && options.entries) {
                this.#entries = options.entries;
                this.#currentIndex = options.index;
                if (options.known) {
                    this.#known = new Set([...this.#known, ...options.known]);
                }
                return entry;
            } else if (!entry) {
                throw new InvalidStateError();
            }

            const microtask = new Promise<void>(queueMicrotask);
            const transitionResult = await createAppHistoryTransition({
                current,
                currentIndex: this.#currentIndex,
                abortController,
                entries: this.#entries,
                entry,
                options,
                navigationType,
                transition: currentTransition,
                startTime,
                known: this.#known,
                transitionWhile
            });

            const {
                known,
                entries,
                index,
                currentChange,
                navigate,
            } = transitionResult;

            if (abortController.signal.aborted) {
                throw new InvalidStateError("Aborted");
            }

            if (typeof navigationType === "string") {
                this.#activeTransition = currentTransition;
            }

            if (typeof navigationType === "string" || navigationType === Rollback) {
                await current?.dispatchEvent({
                    type: "navigatefrom",
                    transitionWhile,
                });
            }

            if (typeof navigationType === "string") {
                await this.dispatchEvent(navigate);
            }

            if (abortController.signal.aborted) {
                throw new InvalidStateError("Aborted");
            }

            this.#known = new Set([...this.#known, ...known]);
            this.#entries = entries;
            this.#currentIndex = index;

            if (entry.sameDocument) {
                await this.dispatchEvent(currentChange);
            }
            if (typeof navigationType === "string") {
                await entry.dispatchEvent({
                    type: "navigateto",
                    transitionWhile,
                });
            }
            await this.#dispose();
            if (!promises.length) {
                await microtask;
            }
            if (promises.length) {
                const capturedPromises = promises;
                promises = []; // Reset so that we can collect more if needed
                await Promise.all(capturedPromises);
            }

            if (typeof navigationType === "string") {
                await entry.dispatchEvent({
                    type: "finish",
                    transitionWhile
                });
            }
            if (typeof navigationType === "string") {
                await this.dispatchEvent({
                    type: "navigatesuccess",
                    transitionWhile
                });
            }

            // If we have more length here, we have added more transition
            if (promises.length) {
                const capturedPromises = promises;
                // Clear so we can see if there are any uncaught promises
                // TODO check this length in finally, throw if length
                promises = [];
                await Promise.all(capturedPromises);
            }

            return entry;
        }

        try {
            return await completeTransition();
        } catch (error) {
            if (!(error instanceof InvalidStateError) && (typeof navigationType === "string" || navigationType === Rollback)) {
                if (navigationType !== Rollback) {
                    // console.warn("Rolling back immediately due to internal error", error);
                    await rollbackImmediately();
                }
                await this.dispatchEvent({
                    type: "navigateerror",
                    error,
                    get message() {
                        if (error instanceof Error) {
                            return error.message;
                        }
                        return `${error}`;
                    }
                });
            }
            // console.log("Error for", entry, error);
            throw await Promise.reject(error);

        } finally {
            await this.#dispose();

            if (this.#activeTransition === currentTransition) {
                this.#activeTransition = undefined;
            }

            if (entry.sameDocument && typeof navigationType === "string") {
                performance.mark(`same-document-navigation-finish:${entry.id}`);
                performance.measure(
                    `same-document-navigation:${entry.url}`,
                    `same-document-navigation:${entry.id}`,
                    `same-document-navigation-finish:${entry.id}`
                );
            }
        }

        function transitionWhile(newNavigationAction: Promise<unknown>): void {
            if (abortController.signal.aborted) {
                throw new InvalidStateError("Event has already finished processing");
            }
            promises.push(newNavigationAction);
        }
    }

    #dispose = async () => {
        // console.log(JSON.stringify({ known: [...this.#known], entries: this.#entries }));
        for (const known of this.#known) {
            const index = this.#entries.findIndex(entry => entry.key === known.key);
            if (index !== -1) {
                // Still in use
                continue;
            }
            // No index, no longer known
            this.#known.delete(known);
            const event = {
                type: "dispose",
                entry: known
            };
            await known.dispatchEvent(event);
            await this.dispatchEvent(event);
        }
        // console.log(JSON.stringify({ pruned: [...this.#known] }));
    }

    reload(options?: AppHistoryReloadOptions): AppHistoryResult {
        const { current } = this;
        if (!current) throw new InvalidStateError();
        const entry = this.#cloneAppHistoryEntry(current, options);
        return this.#pushEntry("reload", entry, undefined, options);
    }

    updateCurrent(options: AppHistoryUpdateCurrentOptions): AppHistoryResult
    updateCurrent(options: AppHistoryUpdateCurrentOptions): void
    updateCurrent(options: AppHistoryUpdateCurrentOptions): AppHistoryResult {
        const { current } = this;
        const entry = this.#cloneAppHistoryEntry(current, options);
        return this.#pushEntry(UpdateCurrent, entry, undefined, options);
    }

}

async function getPerformance(): Promise<{
    now(): number;
    measure(name: string, start: string, finish: string): unknown;
    mark(mark: string): unknown;
}> {
    if (typeof performance !== "undefined") {
        return performance;
    }
    /* c8 ignore start */
    return {
        now() {
            return Date.now()
        },
        mark() {

        },
        measure() {
        }
    }
    // const { performance: nodePerformance } = await import("perf_hooks");
    // return nodePerformance;
    /* c8 ignore end */
}