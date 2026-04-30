// Escrow-flow task routes: create, list, fetch, deliver, refund, dispatch, note,
// + agent registry lookup.

import type { FastifyInstance } from "fastify";
import {
  TaskModel,
  TASK_STATUSES,
  nextTaskId,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import {
  getAgentRegistry,
  isKnownAgent,
  listAgents,
} from "../lib/agent-registry.js";
import { getLocusClient } from "../lib/locus.js";
import { publish } from "../lib/sse-bus.js";
import {
  dispatchTask,
  refundTask,
  releaseTask,
  serializeTask,
} from "../lib/task-actions.js";

interface CreateBody {
  agentId: string;
  input: string;
  userIdentifier?: string;
}

interface DeliverBody {
  output: string;
  modelUsed?: string;
}

interface NoteBody {
  type: "processing" | "borrowing" | "borrowed" | "doing-work";
  loanId?: string;
}

interface ListQuery {
  status?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
}

export async function tasksRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  // ── GET /agents/registry ────────────────────────────────────────────
  app.get("/agents/registry", async () => ({ agents: await listAgents() }));

  // ── POST /tasks ─────────────────────────────────────────────────────
  app.post<{ Body: CreateBody }>(
    "/tasks",
    {
      schema: {
        body: {
          type: "object",
          required: ["agentId", "input"],
          additionalProperties: false,
          properties: {
            agentId: { type: "string", minLength: 1 },
            input: { type: "string", minLength: 10, maxLength: 4000 },
            userIdentifier: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { agentId, input } = req.body;
      const userIdentifier =
        req.body.userIdentifier ??
        `anon-${Math.random().toString(36).slice(2, 10)}`;

      if (!(await isKnownAgent(agentId))) {
        return reply.code(400).send({ error: "unknown_agent", agentId });
      }
      const meta = await getAgentRegistry(agentId);
      if (!meta) {
        return reply.code(400).send({ error: "unknown_agent", agentId });
      }

      const taskId = await nextTaskId();
      const locus = getLocusClient();
      const session = await locus.createSession({
        amount: meta.pricingUsdc.toFixed(4),
        currency: "USDC",
        ttlSeconds: 1200,
        metadata: { taskId, agentId },
        receiptConfig: {
          enabled: true,
          fields: {
            creditorName: "CREDIT Agent Marketplace",
            lineItems: [
              {
                description: `${meta.displayName} task`,
                amount: meta.pricingUsdc.toFixed(4),
              },
            ],
          },
        },
      });

      const task = await TaskModel.create({
        taskId,
        userIdentifier,
        agentId,
        input,
        pricingUsdc: meta.pricingUsdc,
        escrowSessionId: session.id,
        escrowSessionStatus: "PENDING",
        status: "DRAFT",
      });

      publish({
        kind: "task.created",
        ts: Date.now(),
        taskId,
        agentId,
        pricingUsdc: meta.pricingUsdc,
      });
      req.log.info({ taskId, agentId, sessionId: session.id }, "task created");

      return {
        task: serializeTask(task),
        checkoutUrl: session.checkoutUrl,
        sessionId: session.id,
      };
    },
  );

  // ── GET /tasks ──────────────────────────────────────────────────────
  app.get<{ Querystring: ListQuery }>(
    "/tasks",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: [...TASK_STATUSES] },
            agentId: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 20;
      const offset = req.query.offset ?? 0;
      const filter: Record<string, unknown> = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.agentId) filter.agentId = req.query.agentId;
      const [total, rows] = await Promise.all([
        TaskModel.countDocuments(filter),
        TaskModel.find(filter)
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean(),
      ]);
      return {
        tasks: rows,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + rows.length < total,
        },
      };
    },
  );

  // ── GET /tasks/:taskId ──────────────────────────────────────────────
  app.get<{ Params: { taskId: string } }>(
    "/tasks/:taskId",
    async (req, reply) => {
      const task = await TaskModel.findOne({ taskId: req.params.taskId }).lean();
      if (!task) {
        return reply.code(404).send({ error: "task_not_found" });
      }
      const agent = await getAgentRegistry(task.agentId);
      return { task, agent };
    },
  );

  // ── POST /tasks/:taskId/deliver ─────────────────────────────────────
  app.post<{ Params: { taskId: string }; Body: DeliverBody }>(
    "/tasks/:taskId/deliver",
    {
      schema: {
        body: {
          type: "object",
          required: ["output"],
          additionalProperties: true,
          properties: {
            output: { type: "string" },
            modelUsed: { type: "string" },
            failed: { type: "boolean" },
            reason: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { taskId } = req.params;
      const task = await TaskModel.findOne({ taskId });
      if (!task) {
        return reply.code(404).send({ error: "task_not_found" });
      }

      // Failure path: agent reports it couldn't complete.
      const failedFlag = (req.body as unknown as { failed?: boolean }).failed;
      const reason = (req.body as unknown as { reason?: string }).reason;
      if (failedFlag === true) {
        task.status = "FAILED";
        task.lastDispatchError = reason ?? "agent_reported_failure";
        await task.save();
        publish({
          kind: "task.failed",
          ts: Date.now(),
          taskId,
          reason: reason ?? "agent_reported_failure",
        });
        void refundTask(taskId, config, req.log).catch(() => {});
        return { task: serializeTask(task), accepted: true };
      }

      if (
        task.status !== "DISPATCHED" &&
        task.status !== "PROCESSING"
      ) {
        return reply
          .code(400)
          .send({ error: "wrong_state", state: task.status });
      }

      task.output = req.body.output;
      task.outputAt = new Date();
      task.modelUsed = req.body.modelUsed ?? null;
      task.status = "DELIVERED";
      await task.save();

      publish({
        kind: "task.delivered",
        ts: Date.now(),
        taskId,
        agentId: task.agentId,
        modelUsed: task.modelUsed,
        charsOutput: req.body.output.length,
      });

      // Async: verify + release (or refund on failure).
      void releaseTask(taskId, req.log, config).catch((err) =>
        req.log.error({ err, taskId }, "release errored"),
      );

      return { task: serializeTask(task), releaseAcknowledged: true };
    },
  );

  // ── POST /tasks/:taskId/refund ──────────────────────────────────────
  app.post<{ Params: { taskId: string } }>(
    "/tasks/:taskId/refund",
    async (req, reply) => {
      const task = await TaskModel.findOne({ taskId: req.params.taskId });
      if (!task) return reply.code(404).send({ error: "task_not_found" });
      if (task.status === "RELEASED") {
        return reply.code(400).send({ error: "already_released" });
      }
      await refundTask(req.params.taskId, config, req.log);
      return { ok: true };
    },
  );

  // ── POST /tasks/:taskId/dispatch (internal) ─────────────────────────
  app.post<{ Params: { taskId: string } }>(
    "/tasks/:taskId/dispatch",
    async (req, reply) => {
      const task = await TaskModel.findOne({ taskId: req.params.taskId });
      if (!task) return reply.code(404).send({ error: "task_not_found" });
      if (task.status !== "PAID") {
        return reply.code(400).send({ error: "wrong_state", state: task.status });
      }
      void dispatchTask(req.params.taskId, config, req.log).catch(() => {});
      return { ok: true };
    },
  );

  // ── POST /tasks/:taskId/note ────────────────────────────────────────
  app.post<{ Params: { taskId: string }; Body: NoteBody }>(
    "/tasks/:taskId/note",
    {
      schema: {
        body: {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: ["processing", "borrowing", "borrowed", "doing-work"],
            },
            loanId: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { taskId } = req.params;
      const { type, loanId } = req.body;
      const task = await TaskModel.findOne({ taskId });
      if (!task) return reply.code(404).send({ error: "task_not_found" });

      if (type === "processing") {
        if (task.status === "DISPATCHED") task.status = "PROCESSING";
        await task.save();
        publish({
          kind: "task.processing",
          ts: Date.now(),
          taskId,
          agentId: task.agentId,
        });
      } else if (type === "borrowing") {
        publish({
          kind: "task.borrowing",
          ts: Date.now(),
          taskId,
          agentId: task.agentId,
        });
      } else if (type === "borrowed") {
        task.borrowedToFulfill = true;
        if (loanId) task.loanId = loanId;
        await task.save();
        publish({
          kind: "task.borrowed",
          ts: Date.now(),
          taskId,
          agentId: task.agentId,
          loanId: loanId ?? "",
        });
      } else if (type === "doing-work") {
        publish({
          kind: "task.processing",
          ts: Date.now(),
          taskId,
          agentId: task.agentId,
        });
      }
      return { ok: true };
    },
  );
}
