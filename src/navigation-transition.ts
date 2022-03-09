import {
    NavigationHistoryEntry as NavigationHistoryEntryPrototype,
    NavigationNavigationOptions,
    NavigationNavigationType,
    NavigationResult,
    NavigationTransition as NavigationTransitionPrototype,
    NavigationTransitionInit as NavigationTransitionInitPrototype
} from "./spec/navigation";
import {NavigationHistoryEntry} from "./navigation-entry";
import {deferred, Deferred} from "./util/deferred";
import {AbortError, InvalidStateError, isAbortError, isInvalidStateError} from "./navigation-errors";
import {Event, EventTarget} from "./event-target";
import AbortController from "abort-controller";

export const Rollback = Symbol.for("@virtualstate/app-history/rollback");
export const Unset = Symbol.for("@virtualstate/app-history/unset");

export type InternalNavigationNavigationType =
    | NavigationNavigationType
    | typeof Rollback
    | typeof Unset;

export const NavigationTransitionParentEventTarget = Symbol.for("@virtualstate/app-history/transition/parentEventTarget");

export const NavigationTransitionFinishedDeferred = Symbol.for("@virtualstate/app-history/transition/deferred/finished");
export const NavigationTransitionCommittedDeferred = Symbol.for("@virtualstate/app-history/transition/deferred/committed");
export const NavigationTransitionNavigationType = Symbol.for("@virtualstate/app-history/transition/navigationType");
export const NavigationTransitionInitialEntries = Symbol.for("@virtualstate/app-history/transition/entries/initial");
export const NavigationTransitionFinishedEntries = Symbol.for("@virtualstate/app-history/transition/entries/finished");
export const NavigationTransitionInitialIndex = Symbol.for("@virtualstate/app-history/transition/index/initial");
export const NavigationTransitionFinishedIndex = Symbol.for("@virtualstate/app-history/transition/index/finished");
export const NavigationTransitionEntry = Symbol.for("@virtualstate/app-history/transition/entry");


export const NavigationTransitionIsCommitted = Symbol.for("@virtualstate/app-history/transition/isCommitted");
export const NavigationTransitionIsFinished = Symbol.for("@virtualstate/app-history/transition/isFinished");
export const NavigationTransitionIsRejected = Symbol.for("@virtualstate/app-history/transition/isRejected");

export const NavigationTransitionKnown = Symbol.for("@virtualstate/app-history/transition/known");
export const NavigationTransitionPromises = Symbol.for("@virtualstate/app-history/transition/promises");

export const NavigationTransitionWhile = Symbol.for("@virtualstate/app-history/transition/while");
export const NavigationTransitionIsOngoing = Symbol.for("@virtualstate/app-history/transition/isOngoing");
export const NavigationTransitionIsPending = Symbol.for("@virtualstate/app-history/transition/isPending");
export const NavigationTransitionWait = Symbol.for("@virtualstate/app-history/transition/wait");

export const NavigationTransitionPromiseResolved = Symbol.for("@virtualstate/app-history/transition/promise/resolved");

export const NavigationTransitionRejected = Symbol.for("@virtualstate/app-history/transition/rejected");

export const NavigationTransitionCommit = Symbol.for("@virtualstate/app-history/transition/commit");
export const NavigationTransitionFinish = Symbol.for("@virtualstate/app-history/transition/finish");
export const NavigationTransitionStart = Symbol.for("@virtualstate/app-history/transition/start");
export const NavigationTransitionStartDeadline = Symbol.for("@virtualstate/app-history/transition/start/deadline");
export const NavigationTransitionError = Symbol.for("@virtualstate/app-history/transition/error");
export const NavigationTransitionFinally = Symbol.for("@virtualstate/app-history/transition/finally");
export const NavigationTransitionAbort = Symbol.for("@virtualstate/app-history/transition/abort");

export interface NavigationTransitionInit extends Omit<NavigationTransitionInitPrototype, "finished"> {
    rollback(options?: NavigationNavigationOptions): NavigationResult;
    [NavigationTransitionFinishedDeferred]?: Deferred<NavigationHistoryEntry>;
    [NavigationTransitionCommittedDeferred]?: Deferred<NavigationHistoryEntry>;
    [NavigationTransitionNavigationType]: InternalNavigationNavigationType;
    [NavigationTransitionInitialEntries]: NavigationHistoryEntry[];
    [NavigationTransitionInitialIndex]: number;
    [NavigationTransitionFinishedEntries]?: NavigationHistoryEntry[];
    [NavigationTransitionFinishedIndex]?: number;
    [NavigationTransitionKnown]?: Iterable<EventTarget>;
    [NavigationTransitionEntry]: NavigationHistoryEntry;
    [NavigationTransitionParentEventTarget]: EventTarget;
}

export class NavigationTransition extends EventTarget implements NavigationTransitionPrototype {
    readonly finished: Promise<NavigationHistoryEntryPrototype>;
    /**
     * @experimental
     */
    readonly committed: Promise<NavigationHistoryEntryPrototype>;
    readonly from: NavigationHistoryEntryPrototype;
    readonly navigationType: NavigationNavigationType;

    readonly #options: NavigationTransitionInit;

    readonly [NavigationTransitionFinishedDeferred] = deferred<NavigationHistoryEntry>();
    readonly [NavigationTransitionCommittedDeferred] = deferred<NavigationHistoryEntry>();

    get [NavigationTransitionIsPending]() {
        return !!this.#promises.size;
    }

    get [NavigationTransitionNavigationType](): InternalNavigationNavigationType {
        return this.#options[NavigationTransitionNavigationType];
    }

    get [NavigationTransitionInitialEntries](): NavigationHistoryEntry[] {
        return this.#options[NavigationTransitionInitialEntries];
    }

    get [NavigationTransitionInitialIndex](): number {
        return this.#options[NavigationTransitionInitialIndex];
    }

    [NavigationTransitionFinishedEntries]?: NavigationHistoryEntry[];
    [NavigationTransitionFinishedIndex]?: number;
    [NavigationTransitionIsCommitted] = false;
    [NavigationTransitionIsFinished] = false;
    [NavigationTransitionIsRejected] = false;
    [NavigationTransitionIsOngoing] = false;

    readonly [NavigationTransitionKnown] = new Set<EventTarget>();
    readonly [NavigationTransitionEntry]: NavigationHistoryEntry;

    #promises = new Set<Promise<PromiseSettledResult<void>>>()

    #rolledBack = false;

    #abortController = new AbortController();

    get signal() {
        return this.#abortController.signal;
    }

    get [NavigationTransitionPromises]() {
        return this.#promises;
    }

    constructor(init: NavigationTransitionInit) {
        super();
        this[NavigationTransitionFinishedDeferred] =
            init[NavigationTransitionFinishedDeferred] ?? this[NavigationTransitionFinishedDeferred];
        this[NavigationTransitionCommittedDeferred] =
            init[NavigationTransitionCommittedDeferred] ?? this[NavigationTransitionCommittedDeferred];

        this.#options = init;
        const finished = this.finished = this[NavigationTransitionFinishedDeferred].promise;
        const committed = this.committed = this[NavigationTransitionCommittedDeferred].promise;
        // Auto catching abort
        void finished.catch(error => error);
        void committed.catch(error => error);
        this.from = init.from;
        this.navigationType = init.navigationType;
        this[NavigationTransitionFinishedEntries] = init[NavigationTransitionFinishedEntries];
        this[NavigationTransitionFinishedIndex] = init[NavigationTransitionFinishedIndex];
        const known = init[NavigationTransitionKnown];
        if (known) {
            for (const entry of known) {
                this[NavigationTransitionKnown].add(entry);
            }
        }
        this[NavigationTransitionEntry] = init[NavigationTransitionEntry];


        // Event listeners
        {
            // Events to promises
            {
                this.addEventListener(
                    NavigationTransitionCommit,
                    this.#onCommitPromise,
                    { once: true }
                );
                this.addEventListener(
                    NavigationTransitionFinish,
                    this.#onFinishPromise,
                    { once: true }
                );
            }

            // Events to property setters
            {
                this.addEventListener(
                    NavigationTransitionCommit,
                    this.#onCommitSetProperty,
                    { once: true }
                );
                this.addEventListener(
                    NavigationTransitionFinish,
                    this.#onFinishSetProperty,
                    { once: true }
                );
            }

            // Rejection + Abort
            {

                this.addEventListener(
                    NavigationTransitionError,
                    this.#onError,
                    { once: true }
                );
                this.addEventListener(
                    NavigationTransitionAbort,
                    () => {
                        if (!this[NavigationTransitionIsFinished]) {
                            return this[NavigationTransitionRejected](new AbortError())
                        }
                    }
                )
            }

            // Proxy all events from this transition onto entry + the parent event target
            //
            // The parent could be another transition, or the Navigation, this allows us to
            // "bubble up" events layer by layer
            //
            // In this implementation, this allows individual transitions to "intercept" navigate and break the child
            // transition from happening
            //
            // TODO WARN this may not be desired behaviour vs standard spec'd Navigation
            {
                this.addEventListener(
                    "*",
                    this[NavigationTransitionEntry].dispatchEvent.bind(this[NavigationTransitionEntry])
                );
                this.addEventListener(
                    "*",
                    init[NavigationTransitionParentEventTarget].dispatchEvent.bind(init[NavigationTransitionParentEventTarget])
                );
            }
        }
    }

    rollback = (options?: NavigationNavigationOptions): NavigationResult => {
        // console.log({ rolled: this.#rolledBack });
        if (this.#rolledBack) {
            // TODO
            throw new InvalidStateError("Rollback invoked multiple times: Please raise an issue at https://github.com/virtualstate/app-history with the use case where you want to use a rollback multiple times, this may have been unexpected behaviour");
        }
        this.#rolledBack = true;
        return this.#options.rollback(options);
    }

    #onCommitSetProperty = () => {
        this[NavigationTransitionIsCommitted] = true
    }

    #onFinishSetProperty = () => {
        this[NavigationTransitionIsFinished] = true
    }

    #onFinishPromise = () => {
        // console.log("onFinishPromise")
        this[NavigationTransitionFinishedDeferred].resolve(
            this[NavigationTransitionEntry]
        );
    }

    #onCommitPromise = () => {
        if (this.signal.aborted) {
        } else {
            this[NavigationTransitionCommittedDeferred].resolve(
                this[NavigationTransitionEntry]
            );
        }

    }

    #onError = (event: Event & { error: unknown }) => {
        return this[NavigationTransitionRejected](event.error);
    }

    [NavigationTransitionPromiseResolved] = (...promises: Promise<PromiseSettledResult<void>>[]) => {
        for (const promise of promises) {
            this.#promises.delete(promise);
        }
    }

    [NavigationTransitionRejected] = async (reason: unknown) => {
        if (this[NavigationTransitionIsRejected]) return;
        this[NavigationTransitionIsRejected] = true;
        this[NavigationTransitionAbort]();

        const navigationType = this[NavigationTransitionNavigationType];

        // console.log({ navigationType, reason, entry: this[NavigationTransitionEntry] });

        if ((typeof navigationType === "string" || navigationType === Rollback)) {
            // console.log("navigateerror", { reason, z: isInvalidStateError(reason) });
            await this.dispatchEvent({
                type: "navigateerror",
                error: reason,
                get message() {
                    if (reason instanceof Error) {
                        return reason.message;
                    }
                    return `${reason}`;
                }
            });
            // console.log("navigateerror finished");

            if (navigationType !== Rollback && !(isInvalidStateError(reason) || isAbortError(reason))) {
                try {

                    // console.log("Rollback", navigationType);
                    // console.warn("Rolling back immediately due to internal error", error);
                    await this.rollback()?.finished;
                    // console.log("Rollback complete", navigationType);
                } catch (error) {
                    // console.error("Failed to rollback", error);
                    throw new InvalidStateError("Failed to rollback, please raise an issue at https://github.com/virtualstate/app-history/issues");
                }
            }
        }
        this[NavigationTransitionCommittedDeferred].reject(reason);
        this[NavigationTransitionFinishedDeferred].reject(reason);
    }

    [NavigationTransitionWhile] = (promise: Promise<unknown>): void => {
        this[NavigationTransitionIsOngoing] = true;
        // console.log({ NavigationTransitionWhile, promise });
        const statusPromise = promise
            .then((): PromiseSettledResult<void> => ({
                status: "fulfilled",
                value: undefined
            }))
            .catch(async (reason): Promise<PromiseSettledResult<void>> => {
                await this[NavigationTransitionRejected](reason);
                return {
                    status: "rejected",
                    reason
                }
            });
        this.#promises.add(statusPromise);
    }

    [NavigationTransitionWait] = async (): Promise<NavigationHistoryEntry> => {
        if (!this.#promises.size) return this[NavigationTransitionEntry];
        try {
            const captured = [...this.#promises];
            const results = await Promise.all(captured);
            const rejected = results.filter<PromiseRejectedResult>(
                (result): result is PromiseRejectedResult => result.status === "rejected"
            );
            // console.log({ rejected, results, captured });
            if (rejected.length) {
                // TODO handle differently when there are failures, e.g. we could move navigateerror to here
                if (rejected.length === 1) {
                    throw rejected[0].reason;
                }
                if (typeof AggregateError !== "undefined") {
                    throw new AggregateError(rejected.map(({ reason }) => reason));
                }
                throw new Error();
            }
            this[NavigationTransitionPromiseResolved](...captured);

            if (this[NavigationTransitionIsPending]) {
                return this[NavigationTransitionWait]();
            }

            return this[NavigationTransitionEntry];
        } catch (error) {
            await this.#onError(error);
            await Promise.reject(error);
            throw error;
        } finally {
            await this[NavigationTransitionFinish]();
        }
    }

    [NavigationTransitionAbort]() {
        if (this.#abortController.signal.aborted) return;
        this.#abortController.abort();
        this.dispatchEvent({
            type: NavigationTransitionAbort,
            transition: this,
            entry: this[NavigationTransitionEntry]
        })
    }

    [NavigationTransitionFinish] = async () => {
        if (this[NavigationTransitionIsFinished]) {
            return;
        }

        await this.dispatchEvent({
            type: NavigationTransitionFinish,
            transition: this,
            entry: this[NavigationTransitionEntry],
            transitionWhile: this[NavigationTransitionWhile]
        })
    }

}