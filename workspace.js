(function (root, factory) {
  'use strict';
  var model = typeof module === 'object' && module.exports ? require('./model.js') : root.RhythmModel;
  var api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LimboWorkspace = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  if (!M) throw new Error('Сначала загрузите model.js');
  var VERSION = 3;
  var MAX_CLIENTS = 1000;
  var MAX_JSON_LENGTH = 64 * 1024 * 1024;
  var own = function (value, key) { return Object.prototype.hasOwnProperty.call(value, key); };
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };

  function WorkspaceError(message) {
    this.name = 'WorkspaceError';
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, WorkspaceError);
  }
  WorkspaceError.prototype = Object.create(Error.prototype);
  WorkspaceError.prototype.constructor = WorkspaceError;
  function fail(message) { throw new WorkspaceError(message); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ': ожидается объект');
    return value;
  }
  function text(value, label, maximum, required) {
    if (value == null && !required) return '';
    if (typeof value !== 'string') fail(label + ': ожидается текст');
    var result = value.trim();
    if (required && !result) fail(label + ': заполните поле');
    if (result.length > maximum) fail(label + ': максимум ' + maximum + ' символов');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) fail(label + ': недопустимые символы');
    return result;
  }
  function identifier(value, label) {
    var result = text(value, label, 128, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) fail(label + ': некорректный идентификатор');
    return result;
  }
  function phone(value) {
    if (value === undefined) return '';
    if (typeof value !== 'string') fail('Телефон: ожидается текст');
    if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) fail('Телефон: недопустимые символы');
    var result = value.trim();
    if (result.length > 40) fail('Телефон: максимум 40 символов');
    return result;
  }
  function parse(raw) {
    if (typeof raw !== 'string') return raw;
    if (raw.length > MAX_JSON_LENGTH) fail('Файл слишком большой: максимум 64 МБ');
    try { return JSON.parse(raw); } catch (error) { fail('Сохранённые данные содержат некорректный JSON'); }
  }
  function role(value, allowEmpty) {
    if (value === 'trainer' || value === 'client' || (allowEmpty && value === null)) return value;
    fail('Выберите роль: тренер или клиент');
  }
  function defaultData() {
    return { version: VERSION, role: null, personal: M.defaultData(), clients: [] };
  }
  function isWorkspaceData(raw) {
    return !!(raw && typeof raw === 'object' && !Array.isArray(raw) && (own(raw, 'role') || own(raw, 'personal') || own(raw, 'clients')));
  }
  function validateData(raw) {
    raw = object(parse(raw), 'Данные');
    if (raw.version !== 2 && raw.version !== VERSION) fail('Версия: поддерживаются версии 2 и ' + VERSION);
    var selectedRole = role(raw.role, true);
    if (!Array.isArray(raw.clients)) fail('Клиенты: ожидается список');
    if (raw.clients.length > MAX_CLIENTS) fail('Клиенты: максимум ' + MAX_CLIENTS + ' записей');
    if (selectedRole !== 'trainer' && raw.clients.length) fail('Список клиентов доступен только тренеру');
    var ids = new Set();
    return {
      version: VERSION,
      role: selectedRole,
      personal: M.validateData(raw.personal),
      clients: raw.clients.map(function (entry, index) {
        var label = 'Клиенты[' + index + ']';
        object(entry, label);
        var id = identifier(entry.id, label + '.id');
        if (ids.has(id)) fail(label + ': повторяющийся идентификатор');
        ids.add(id);
        return { id: id, phone: phone(entry.phone), comment: text(entry.comment, 'Комментарий', 2000, false), diary: M.validateData(entry.diary) };
      })
    };
  }
  function hasPersonalData(diary) {
    var profile = diary.profile;
    return !!(profile.fullName || profile.heightCm !== '' || profile.age !== '' || profile.birthDate || diary.weights.length || diary.workouts.length || diary.measurementTypes.length || diary.measurements.length || diary.bodyFat.length ||
      JSON.stringify(diary.exercises) !== JSON.stringify(M.defaultData().exercises));
  }
  function createStore(adapter) {
    if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') fail('Нужен адаптер хранения с read и write');
    var source = adapter.read();
    var state;
    if (source == null || source === '') state = defaultData();
    else {
      var restored = parse(source);
      if (!isWorkspaceData(restored)) {
        state = defaultData();
        state.personal = M.validateData(restored);
      } else state = validateData(restored);
    }
    function data() { return clone(state); }
    function requireTrainer() { if (state.role !== 'trainer') fail('Сначала выберите роль тренера'); }
    function clientAt(draft, clientId) {
      var entry = draft.clients.find(function (item) { return item.id === clientId; });
      if (!entry) fail('Клиент не найден');
      return entry;
    }
    function diaryAt(draft, clientId) {
      if (clientId == null) {
        if (draft.role === 'trainer') fail('Сначала выберите клиента');
        return draft.personal;
      }
      if (draft.role !== 'trainer') fail('Дневники клиентов доступны только тренеру');
      return clientAt(draft, clientId).diary;
    }
    function persist(raw) {
      var next = validateData(raw);
      var serialized = JSON.stringify(next);
      if (serialized.length > MAX_JSON_LENGTH) fail('Данные слишком большие: максимум 64 МБ');
      var outcome = adapter.write(serialized);
      if (outcome === false) fail('Не удалось сохранить данные. Изменения не применены');
      if (outcome && typeof outcome.then === 'function') fail('Хранение данных должно быть синхронным');
      state = next;
      return data();
    }
    function replace(raw) {
      var next = validateData(raw);
      if (state.role !== null && next.role !== state.role) fail('Роль уже выбрана. Изменить её нельзя');
      return persist(next);
    }
    function importDiary(clientId, raw) {
      var nextDiary = M.validateData(parse(raw));
      var draft = data();
      diaryAt(draft, clientId);
      if (clientId == null) draft.personal = nextDiary;
      else clientAt(draft, clientId).diary = nextDiary;
      return persist(draft);
    }
    return {
      data: data,
      getRole: function () { return state.role; },
      chooseRole: function (selectedRole) {
        selectedRole = role(selectedRole, false);
        if (state.role === selectedRole) return data();
        if (state.role !== null) fail('Роль уже выбрана. Изменить её нельзя');
        var draft = data();
        draft.role = selectedRole;
        if (selectedRole === 'trainer' && hasPersonalData(draft.personal)) {
          var diary = draft.personal;
          if (!diary.profile.fullName) diary.profile.fullName = 'Клиент';
          draft.clients.push({ id: M.uid(), phone: '', comment: '', diary: diary });
          draft.personal = M.defaultData();
        }
        return persist(draft);
      },
      getDiary: function (clientId) { return clone(diaryAt(state, clientId)); },
      adapterForDiary: function (clientId) {
        diaryAt(state, clientId);
        return {
          read: function () { return JSON.stringify(diaryAt(state, clientId)); },
          write: function (serialized) { importDiary(clientId, serialized); return true; }
        };
      },
      listClients: function () { requireTrainer(); return clone(state.clients); },
      addClient: function (fields) {
        requireTrainer();
        object(fields, 'Клиент');
        var fullName = text(fields.fullName, 'ФИО', 160, true);
        var clientPhone = phone(fields.phone);
        var comment = text(fields.comment, 'Комментарий', 2000, false);
        if (state.clients.length >= MAX_CLIENTS) fail('Клиенты: максимум ' + MAX_CLIENTS + ' записей');
        var diary = M.defaultData();
        diary.profile.fullName = fullName;
        var draft = data();
        var id = M.uid();
        while (draft.clients.some(function (entry) { return entry.id === id; })) id = M.uid();
        draft.clients.push({ id: id, phone: clientPhone, comment: comment, diary: diary });
        persist(draft);
        return id;
      },
      updateClient: function (clientId, fields) {
        requireTrainer();
        object(fields, 'Клиент');
        var draft = data();
        var entry = clientAt(draft, clientId);
        if (own(fields, 'fullName')) entry.diary.profile.fullName = text(fields.fullName, 'ФИО', 160, true);
        if (own(fields, 'phone')) entry.phone = phone(fields.phone);
        if (own(fields, 'comment')) entry.comment = text(fields.comment, 'Комментарий', 2000, false);
        return persist(draft);
      },
      removeClient: function (clientId) {
        requireTrainer();
        var draft = data();
        clientAt(draft, clientId);
        draft.clients = draft.clients.filter(function (entry) { return entry.id !== clientId; });
        return persist(draft);
      },
      exportWorkspace: data,
      replace: replace,
      importDiary: importDiary
    };
  }
  return Object.freeze({ VERSION: VERSION, WorkspaceError: WorkspaceError, defaultData: defaultData, isWorkspaceData: isWorkspaceData, validateData: validateData, hasPersonalData: hasPersonalData, hasMeaningfulData: hasPersonalData, createStore: createStore });
}));
