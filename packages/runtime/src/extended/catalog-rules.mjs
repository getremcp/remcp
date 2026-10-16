import { requiredAny } from './catalog-schemas.mjs';

export function applySchemaRules(name, schema) {
  const next = structuredClone(schema);
  if (name === 'computer_action') {
    const nativeTarget = requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']);
    const browserElementTarget = requiredAny(['selector'], ['browser_text'], ['name']);
    const windowTarget = requiredAny(['window_id'], ['pid'], ['app'], ['window_title'], ['title']);
    const semanticTarget = [...nativeTarget, ...browserElementTarget];
    next.allOf = [
      {
        if:{ properties:{ target:{ const:'window' } }, required:['target'] },
        then:{
          properties:{ action:{ enum:['type','focus','scroll','drag'] } },
          anyOf:windowTarget,
        },
      },
      {
        if:{ properties:{ action:{ const:'click' } }, required:['action'] },
        then:{ anyOf:[...semanticTarget, { required:['ocr_text'] }, { required:['x','y'] }] },
      },
      {
        if:{ properties:{ action:{ enum:['invoke','set_value','select','toggle','expand','collapse','scroll_into_view','set_range_value','add_to_selection','remove_from_selection'] } }, required:['action'] },
        then:{ anyOf:semanticTarget },
      },
      {
        if:{ properties:{ action:{ const:'focus' } }, required:['action'] },
        then:{ anyOf:[...semanticTarget, ...requiredAny(['window_id'], ['pid'], ['app'], ['window_title'], ['title'])] },
      },
      {
        if:{ properties:{ action:{ const:'type' } }, required:['action'] },
        then:{
          required:['text'],
          properties:{ target:{ enum:['auto','ui','ui_element','browser','window'] } },
          allOf:[
            { anyOf:[...semanticTarget, ...windowTarget] },
            {
              if:{ properties:{ target:{ enum:['ui','ui_element'] } }, required:['target'] },
              then:{ anyOf:nativeTarget },
            },
            {
              if:{ properties:{ target:{ const:'browser' } }, required:['target'] },
              then:{ anyOf:browserElementTarget },
            },
          ],
        },
      },
      {
        if:{ properties:{ action:{ const:'scroll' } }, required:['action'] },
        then:{
          properties:{ target:{ enum:['auto','ui','ui_element','browser','coordinates','window'] } },
          allOf:[
            { anyOf:requiredAny(['delta_x'], ['delta_y'], ['delta'], ['direction']) },
            {
              if:{ properties:{ target:{ enum:['ui','ui_element'] } }, required:['target'] },
              then:{ anyOf:nativeTarget },
            },
            {
              if:{ properties:{ target:{ const:'coordinates' } }, required:['target'] },
              then:{ required:['x','y'] },
            },
          ],
        },
      },
      {
        if:{ properties:{ action:{ const:'drag' } }, required:['action'] },
        then:{
          properties:{ target:{ enum:['auto','ui','ui_element','coordinates','window'] } },
          allOf:[
            { anyOf:requiredAny(['from_id'], ['from_x','from_y']) },
            { anyOf:requiredAny(['to_id'], ['to_x','to_y']) },
            {
              if:{ properties:{ target:{ enum:['ui','ui_element'] } }, required:['target'] },
              then:{ required:['from_id','to_id'] },
            },
            {
              if:{ properties:{ target:{ const:'coordinates' } }, required:['target'] },
              then:{ required:['from_x','from_y','to_x','to_y'] },
            },
          ],
        },
      },
      {
        if:{ properties:{ action:{ enum:['set_value','set_range_value'] } }, required:['action'] },
        then:{ required:['value'] },
      },
      {
        if:{ properties:{ action:{ const:'multi_select' } }, required:['action'] },
        then:{ required:['targets'] },
      },
      {
        if:{ properties:{ action:{ const:'multi_edit' } }, required:['action'] },
        then:{ required:['edits'] },
      },
    ];
  } else if (name === 'ui_find') {
    next.anyOf = requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']);
  } else if (name === 'ui_action') {
    next.allOf = [
      { anyOf:requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']) },
      {
        if:{ properties:{ action:{ enum:['set_value','set_range_value'] } }, required:['action'] },
        then:{ required:['value'] },
      },
    ];
  } else if (name === 'wait_for_ui') {
    next.anyOf = requiredAny(['state'], ['condition']);
    next.allOf = [
      {
        if:{ properties:{ condition:{ const:'text_exists' } }, required:['condition'] },
        then:{ required:['text'] },
      },
      {
        if:{ properties:{ condition:{ const:'active_window' } }, required:['condition'] },
        then:{ anyOf:requiredAny(['text'], ['name'], ['window_title']) },
      },
      {
        if:{ properties:{ condition:{ enum:['element_exists','element_enabled'] } }, required:['condition'] },
        then:{ anyOf:requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']) },
      },
      {
        if:{ properties:{ state:{ enum:['present','absent'] } }, required:['state'] },
        then:{ anyOf:requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']) },
      },
    ];
  } else if (name === 'window_action') {
    next.allOf = [
      { anyOf:requiredAny(['id'], ['pid'], ['app'], ['title']) },
      {
        if:{ properties:{ action:{ const:'move' } }, required:['action'] },
        then:{ required:['x','y'] },
      },
      {
        if:{ properties:{ action:{ const:'resize' } }, required:['action'] },
        then:{ required:['width','height'] },
      },
      {
        if:{ properties:{ action:{ const:'move_resize' } }, required:['action'] },
        then:{ required:['x','y','width','height'] },
      },
    ];
  } else if (name === 'pointer') {
    next.allOf = [{
      if:{ properties:{ action:{ const:'move' } }, required:['action'] },
      then:{ required:['x','y'] },
    }];
  } else if (name === 'scroll') {
    next.anyOf = requiredAny(['delta_x'], ['delta_y'], ['delta'], ['direction']);
  } else if (name === 'network') {
    next.allOf = [{
      if:{ properties:{ action:{ const:'test' } }, required:['action'] },
      then:{ required:['host','port'] },
    }];
  } else if (name === 'launch_app') {
    next.anyOf = requiredAny(['app'], ['path']);
  } else if (name === 'keyboard') {
    next.anyOf = requiredAny(['shortcut'], ['key'], ['keys']);
    if (next.properties?.keys) next.properties.keys.minItems = 1;
  } else if (name === 'drag_drop') {
    next.allOf = [
      { anyOf: requiredAny(['from_id'], ['from_x','from_y']) },
      { anyOf: requiredAny(['to_id'], ['to_x','to_y']) },
    ];
  } else if (name === 'screenshot_region') {
    next.anyOf = [
      { required:['x','y','width','height'] },
      ...requiredAny(['window_id'], ['pid'], ['app'], ['title'], ['monitor'], ['monitor_index']),
    ];
  } else if (name === 'browser_find') {
    next.anyOf = requiredAny(['selector'], ['text'], ['role']);
  } else if (name === 'browser_navigate') {
    next.allOf = [{
      if:{ properties:{ action:{ enum:['url','new_tab'] } }, required:['action'] },
      then:{ required:['url'] },
    }];
  } else if (name === 'browser_action') {
    next.allOf = [
      {
        if:{ properties:{ action:{ enum:['click','focus','set_value','select','scroll_into_view'] } }, required:['action'] },
        then:{ anyOf:requiredAny(['selector'], ['text'], ['browser_text']) },
      },
      {
        if:{ properties:{ action:{ const:'type' } }, required:['action'] },
        then:{
          required:['text'],
          anyOf:requiredAny(['selector'], ['browser_text'], ['value'], ['text_value']),
        },
      },
      {
        if:{ properties:{ action:{ const:'scroll' } }, required:['action'] },
        then:{ anyOf:requiredAny(['delta_x'], ['delta_y'], ['delta'], ['direction']) },
      },
      {
        if:{ properties:{ action:{ const:'upload' } }, required:['action'] },
        then:{ required:['selector'], anyOf:requiredAny(['path'], ['paths']) },
      },
      {
        if:{ properties:{ action:{ const:'press' } }, required:['action'] },
        then:{ required:['key'] },
      },
    ];
    if (next.properties?.paths) next.properties.paths.minItems = 1;
  } else if (name === 'browser_wait') {
    next.allOf = [
      {
        if:{ not:{ required:['condition'] } },
        then:{ required:['selector'] },
      },
      {
        if:{ properties:{ condition:{ const:'selector' } }, required:['condition'] },
        then:{ required:['selector'] },
      },
      {
        if:{ properties:{ condition:{ const:'text' } }, required:['condition'] },
        then:{ required:['text'] },
      },
      {
        if:{ properties:{ condition:{ const:'url_contains' } }, required:['condition'] },
        then:{ anyOf:requiredAny(['value'], ['text']) },
      },
    ];
  } else if (name === 'service') {
    next.allOf = [{
      if:{ properties:{ action:{ enum:['status','start','stop','restart'] } }, required:['action'] },
      then:{ required:['name'] },
    }];
  } else if (name === 'audio') {
    next.allOf = [{
      if:{ properties:{ action:{ const:'set_volume' } }, required:['action'] },
      then:{ required:['volume'] },
    }];
  } else if (name === 'pdf_action') {
    next.allOf = [
      {
        if:{ properties:{ action:{ enum:['annotations','info','split','extract_pages'] } }, required:['action'] },
        then:{ required:['path'] },
      },
      {
        if:{ properties:{ action:{ const:'merge' } }, required:['action'] },
        then:{ required:['paths','output'] },
      },
      {
        if:{ properties:{ action:{ const:'extract_pages' } }, required:['action'] },
        then:{ required:['pages','output'] },
      },
    ];
    if (next.properties?.paths) {
      next.properties.paths.minItems = 2;
      next.properties.paths.maxItems = 100;
    }
  }
  return next;
}
