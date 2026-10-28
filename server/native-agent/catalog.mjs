// Decorate native menu messages with provider metadata; model-family prompts stay native.
export function catalogEntry(entry, model) {
  const value = entry.toJson();
  Object.assign(value, {
    name: model.cursorId, serverModelName: model.cursorId, defaultOn: true,
    vendorName: model.source, contextTokenLimit: model.contextLength,
    contextTokenLimitForMaxMode: model.contextLength, supportsMaxMode: false,
    legacySlugs: [model.cursorId],
  });
  value.variants ??= [];
  value.parameterDefinitions ??= [];
  if (!value.variants.length) value.variants.push({parameterValues:[],displayName:value.clientDisplayName,isDefaultNonMaxConfig:true,isDefaultMaxConfig:true});
  const efforts = [...new Set(model.reasoningEfforts ?? [])];
  if (efforts.length) {
    const previousDefault = value.variants.find(v=>v.isDefaultNonMaxConfig)?.parameterValues?.find(p=>p.id==='reasoning')?.value;
    const preferred = [model.defaultReasoningEffort, previousDefault, efforts[0]].find(v=>efforts.includes(v));
    const label = s => s === 'xhigh' ? 'Extra High' : s.charAt(0).toUpperCase()+s.slice(1);
    value.parameterDefinitions = value.parameterDefinitions.filter(p=>p.id!=='reasoning');
    value.parameterDefinitions.push({id:'reasoning',name:'Reasoning',isCycleableByHotkey:true,parameterType:{enumParameter:{values:efforts.map(e=>({value:e,displayName:label(e)}))}}});
    const bases = new Map();
    for (const variant of value.variants) {
      const parameters = (variant.parameterValues ?? []).filter(p=>p.id!=='reasoning');
      const key = JSON.stringify([parameters,!!variant.isMaxMode]);
      const base = bases.get(key);
      if (base) {
        base.isDefaultNonMaxConfig ||= variant.isDefaultNonMaxConfig;
        base.isDefaultMaxConfig ||= variant.isDefaultMaxConfig;
      } else bases.set(key,{...variant,parameterValues:parameters});
    }
    value.variants = [...bases.values()].flatMap(base=>efforts.map(e=>({
      ...base, parameterValues:[...base.parameterValues,{id:'reasoning',value:e}],
      displayName:`${value.clientDisplayName} ${label(e)}`,
      displayNameOutsidePicker:`${value.clientDisplayName} ${label(e)}`,
      isDefaultNonMaxConfig:!!base.isDefaultNonMaxConfig && e===preferred,
      isDefaultMaxConfig:!!base.isDefaultMaxConfig && e===preferred,
    })));
    value.supportsThinking = true;
  }
  if (model.supportsFast && !value.parameterDefinitions.some(p=>p.id==='fast'||p.id==='speed')) {
    value.parameterDefinitions.push({id:'fast',name:'Fast',parameterType:{booleanParameter:{values:[{value:'false',displayName:'Off'},{value:'true',displayName:'On'}]}}});
    value.variants = value.variants.flatMap(base=>[false,true].map(fast=>({
      ...base, parameterValues:[...base.parameterValues,{id:'fast',value:String(fast)}],
      displayName:`${base.displayName}${fast?' Fast':''}`,
      displayNameOutsidePicker:`${base.displayNameOutsidePicker??base.displayName}${fast?' Fast':''}`,
      isDefaultNonMaxConfig:!!base.isDefaultNonMaxConfig&&!fast,
      isDefaultMaxConfig:!!base.isDefaultMaxConfig&&!fast,
    })));
  }
  // The current Workbench derives its modelName from this field when a variant is selected.
  // Without it a BYOK selection can be labelled "default", hiding context token counts.
  for (const variant of value.variants) variant.legacySlug = model.cursorId;
  return entry.constructor.fromJson(value);
}
