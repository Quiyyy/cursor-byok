import { api } from "../../shared/api";
import { createStore } from "../../shared/store/createStore";
import type { Model, ModelInput, ModelSettings, CursorModelSettings } from "../../shared/api";
type ModelsState = {
  models: Model[];
  modelSettings: Record<string, ModelSettings>;
  savingModelSettings: ReadonlySet<string>;
  cursorModelSettings: CursorModelSettings | null;
  savingCursorDefaultModel: string | null;
  busy: boolean;
  saving: boolean;
  error: string | null;
};
const state = createStore<ModelsState>({
  models: [],
  modelSettings: {},
  savingModelSettings: new Set(),
  cursorModelSettings: null,
  savingCursorDefaultModel: null,
  busy: false,
  saving: false,
  error: null
});
const update = state.update;
async function perform(task: () => Promise<void>) {
  update({
    error: null
  });
  try {
    await task();
  } catch (cause) {
    update({
      error: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
export const modelsStore = {
  getSnapshot: state.getSnapshot,
  async refresh() {
    const previousDefault = state.getSnapshot().cursorModelSettings;
    update({
      busy: true,
      error: null
    });
    try {
      const [models, modelSettings, cursorModelSettings] = await Promise.all([api.models(), api.allModelSettings(), api.cursorModelSettings()]);
      update({
        models,
        modelSettings,
        cursorModelSettings: state.getSnapshot().cursorModelSettings === previousDefault ? cursorModelSettings : state.getSnapshot().cursorModelSettings
      });
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      update({
        busy: false
      });
    }
  },
  async deleteModel(modelHash: string) {
    await perform(async () => {
      await api.deleteModel(modelHash);
      await modelsStore.refresh();
    });
  },
  async setModelContext(id: string, context_window_tokens: number | null) {
    if (state.getSnapshot().savingModelSettings.has(id)) return false;
    update({
      savingModelSettings: new Set(state.getSnapshot().savingModelSettings).add(id),
      error: null
    });
    try {
      const saved = await api.setModelSettings(id, {
        context_window_tokens
      });
      update({
        modelSettings: {
          ...state.getSnapshot().modelSettings,
          [id]: saved
        },
        models: state.getSnapshot().models.map(model => model.model_hash === id ? {
          ...model,
          context_window_tokens: saved.context_window_tokens
        } : model)
      });
      return true;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return false;
    } finally {
      const saving = new Set(state.getSnapshot().savingModelSettings);
      saving.delete(id);
      update({
        savingModelSettings: saving
      });
    }
  },
  async setCursorDefaultModel(id: string) {
    if (state.getSnapshot().savingCursorDefaultModel !== null || state.getSnapshot().busy || !state.getSnapshot().cursorModelSettings) return false;
    update({
      savingCursorDefaultModel: id,
      error: null
    });
    try {
      update({
        cursorModelSettings: await api.setCursorDefaultModel(id)
      });
      return true;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return false;
    } finally {
      update({
        savingCursorDefaultModel: null
      });
    }
  },
  async createModels(models: ModelInput[]) {
    update({
      saving: true,
      error: null
    });
    try {
      const created = await api.createModels(models);
      await modelsStore.refresh();
      return created;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return null;
    } finally {
      update({
        saving: false
      });
    }
  },
  async updateCursorModel(hash: string, model: ModelInput) {
    update({
      saving: true,
      error: null
    });
    try {
      const updated = await api.updateModel(hash, model);
      await modelsStore.refresh();
      return updated;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return null;
    } finally {
      update({
        saving: false
      });
    }
  },
  async reorderCursorModels(modelHashes: string[]) {
    const previous = state.getSnapshot().models;
    const byHash = new Map(previous.map(model => [model.model_hash, model]));
    if (modelHashes.length !== previous.length || new Set(modelHashes).size !== previous.length) {
      update({
        error: t("模型配置已发生变化，请刷新后重试")
      });
      return false;
    }
    const reordered: Model[] = [];
    for (const [index, hash] of modelHashes.entries()) {
      const model = byHash.get(hash);
      if (!model) {
        update({
          error: t("模型配置已发生变化，请刷新后重试")
        });
        return false;
      }
      reordered.push({
        ...model,
        sort_order: index + 1
      });
    }
    update({
      models: reordered,
      saving: true,
      error: null
    });
    try {
      update({
        models: await api.reorderModels(modelHashes)
      });
      return true;
    } catch (cause) {
      update({
        models: previous,
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return false;
    } finally {
      update({
        saving: false
      });
    }
  }
};
export const useModelsStore = state.useSnapshot;
