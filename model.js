(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RhythmModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 2;
  var fallbackCounter = 0;
  var own = function (value, key) { return Object.prototype.hasOwnProperty.call(value, key); };
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };

  function ModelError(message, path) {
    this.name = 'ModelError';
    this.message = (path ? path + ': ' : '') + message;
    this.path = path || '';
    if (Error.captureStackTrace) Error.captureStackTrace(this, ModelError);
  }
  ModelError.prototype = Object.create(Error.prototype);
  ModelError.prototype.constructor = ModelError;

  function fail(message, path) { throw new ModelError(message, path); }
  function object(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ожидается объект', path);
    return value;
  }
  function list(value, path, max) {
    if (!Array.isArray(value)) fail('ожидается список', path);
    if (value.length > max) fail('слишком много записей', path);
    return value;
  }
  function text(value, path, max, required) {
    if (value == null && !required) return '';
    if (typeof value !== 'string') fail('ожидается текст', path);
    var result = value.trim();
    if (required && !result) fail('заполните поле', path);
    if (result.length > max) fail('максимум ' + max + ' символов', path);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) fail('недопустимые символы', path);
    return result;
  }
  function identifier(value, path) {
    var result = text(value, path, 128, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) fail('некорректный идентификатор', path);
    return result;
  }
  function uniqueId(value, ids, path) {
    var id = identifier(value, path);
    if (ids.has(id)) fail('повторяющийся идентификатор', path);
    ids.add(id);
    return id;
  }
  function parseDecimal(value) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('введите конечное число');
      return value;
    }
    if (typeof value !== 'string') fail('введите число');
    var normalized = value.trim().replace(',', '.');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) fail('введите число');
    var result = Number(normalized);
    if (!Number.isFinite(result)) fail('введите конечное число');
    return result;
  }
  function numeric(value, path, min, max, integer, allowBlank) {
    if (allowBlank && (value == null || (typeof value === 'string' && value.trim() === ''))) return '';
    var result;
    try { result = parseDecimal(value); } catch (error) { fail(error.message, path); }
    if (result < min || result > max) fail('допустимо от ' + min + ' до ' + max, path);
    if (integer && !Number.isInteger(result)) fail('нужно целое число', path);
    return result;
  }
  function bodyWeight(value, path) {
    var result = numeric(value, path, 0, 500, false, false);
    if (result === 0) fail('вес должен быть больше нуля', path);
    return result;
  }
  function normalizeDate(value) {
    if (typeof value !== 'string') fail('дата должна быть в формате ГГГГ-ММ-ДД');
    var result = value.trim();
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
    if (!match) fail('дата должна быть в формате ГГГГ-ММ-ДД');
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('такой даты нет');
    return result;
  }
  function dateAt(value, path) {
    try { return normalizeDate(value); } catch (error) { fail(error.message, path); }
  }
  function localToday(value) {
    var date = value === undefined ? new Date() : value;
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('некорректная дата');
    return String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function birthDate(value, asOf) {
    if (value == null || value === '') return '';
    var date = dateAt(value, 'Дата рождения');
    var today = asOf === undefined ? localToday() : (asOf instanceof Date ? localToday(asOf) : dateAt(asOf, 'Текущая дата'));
    if (date < '1900-01-01' || date > today) fail('укажите дату от 01.01.1900 до сегодняшнего дня', 'Дата рождения');
    return date;
  }
  function ageOn(value, asOf) {
    var today = asOf === undefined ? localToday() : (asOf instanceof Date ? localToday(asOf) : dateAt(asOf, 'Текущая дата'));
    var date = birthDate(value, today);
    if (!date) return null;
    var age = Number(today.slice(0, 4)) - Number(date.slice(0, 4));
    if (today.slice(5) < date.slice(5)) age -= 1;
    return age;
  }
  function profileAge(profile, asOf) {
    if (!profile) return null;
    if (profile.birthDate) return ageOn(profile.birthDate, asOf);
    return profile.age === '' || profile.age == null ? null : numeric(profile.age, 'Возраст', 5, 120, true, false);
  }
  function uid() {
    var cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID();
    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      cryptoObject.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }
    fallbackCounter += 1;
    return 'r-' + Date.now().toString(36) + '-' + fallbackCounter.toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function defaultData() {
    return {
      version: VERSION,
      profile: { fullName: '', heightCm: '', age: '', birthDate: '' },
      weights: [],
      measurementTypes: [],
      measurements: [],
      bodyFat: [],
      exercises: [
        { id: 'exercise-bench-press', name: 'Жим штанги лёжа', muscle: 'Грудь', notes: '', archived: false },
        { id: 'exercise-dumbbell-press', name: 'Жим гантелей сидя', muscle: 'Плечи', notes: '', archived: false },
        { id: 'exercise-biceps-curl', name: 'Подъём гантелей на бицепс', muscle: 'Бицепс', notes: '', archived: false },
        { id: 'exercise-triceps-extension', name: 'Разгибание рук на блоке', muscle: 'Трицепс', notes: '', archived: false },
        { id: 'exercise-lat-pulldown', name: 'Тяга верхнего блока', muscle: 'Спина', notes: '', archived: false },
        { id: 'exercise-seated-row', name: 'Тяга горизонтального блока', muscle: 'Спина', notes: '', archived: false },
        { id: 'exercise-squat', name: 'Приседания со штангой', muscle: 'Ноги', notes: '', archived: false },
        { id: 'exercise-leg-press', name: 'Жим ногами', muscle: 'Ноги', notes: '', archived: false }
      ],
      workouts: []
    };
  }
  function validateData(raw) {
    object(raw, 'Данные');
    if (raw.version !== 1 && raw.version !== VERSION) fail('поддерживаются версии 1 и ' + VERSION, 'Версия');
    if (raw.version === 1) {
      raw = Object.assign({}, raw, { version: VERSION, measurementTypes: [], measurements: [], bodyFat: [] });
    }
    var profile = object(raw.profile, 'Профиль');
    var normalizedBirthDate = birthDate(profile.birthDate);
    var exerciseIds = new Set();
    var weightIds = new Set();
    var workoutIds = new Set();
    var sessionExerciseIds = new Set();
    var setIds = new Set();
    var measurementTypeIds = new Set();
    var measurementNames = new Set();
    var measurementIds = new Set();
    var bodyFatIds = new Set();
    var result = {
      version: VERSION,
      profile: {
        fullName: text(profile.fullName, 'ФИО', 160, false),
        heightCm: numeric(profile.heightCm, 'Рост', 50, 260, false, true),
        age: normalizedBirthDate ? '' : numeric(profile.age, 'Возраст', 5, 120, true, true),
        birthDate: normalizedBirthDate
      },
      weights: list(raw.weights, 'История веса', 50000).map(function (entry, index) {
        var path = 'История веса[' + index + ']';
        object(entry, path);
        return { id: uniqueId(entry.id, weightIds, path + '.id'), date: dateAt(entry.date, path + '.date'), kg: bodyWeight(entry.kg, path + '.kg') };
      }),
      measurementTypes: list(raw.measurementTypes, 'Виды замеров', 200).map(function (entry, index) {
        var path = 'Виды замеров[' + index + ']';
        object(entry, path);
        var name = text(entry.name, path + '.name', 80, true);
        var key = name.toLocaleLowerCase('ru-RU');
        if (measurementNames.has(key)) fail('замер с таким названием уже есть', path + '.name');
        measurementNames.add(key);
        return { id: uniqueId(entry.id, measurementTypeIds, path + '.id'), name: name };
      }),
      measurements: [],
      bodyFat: list(raw.bodyFat, 'Процент жира', 50000).map(function (entry, index) {
        var path = 'Процент жира[' + index + ']';
        object(entry, path);
        return { id: uniqueId(entry.id, bodyFatIds, path + '.id'), date: dateAt(entry.date, path + '.date'), percent: numeric(entry.percent, path + '.percent', 0, 100, false, false) };
      }),
      exercises: list(raw.exercises, 'Упражнения', 5000).map(function (entry, index) {
        var path = 'Упражнения[' + index + ']';
        object(entry, path);
        if (own(entry, 'archived') && typeof entry.archived !== 'boolean') fail('ожидается логическое значение', path + '.archived');
        return {
          id: uniqueId(entry.id, exerciseIds, path + '.id'),
          name: text(entry.name, path + '.name', 120, true),
          muscle: text(entry.muscle, path + '.muscle', 80, false),
          notes: text(entry.notes, path + '.notes', 4000, false),
          archived: entry.archived === true
        };
      }),
      workouts: []
    };
    result.measurements = list(raw.measurements, 'История замеров', 50000).map(function (entry, index) {
      var path = 'История замеров[' + index + ']';
      object(entry, path);
      var ref = identifier(entry.measurementId, path + '.measurementId');
      if (!measurementTypeIds.has(ref)) fail('вид замера отсутствует в справочнике', path + '.measurementId');
      var cm = numeric(entry.cm, path + '.cm', 0, 1000, false, false);
      if (cm === 0) fail('замер должен быть больше нуля', path + '.cm');
      return { id: uniqueId(entry.id, measurementIds, path + '.id'), measurementId: ref, date: dateAt(entry.date, path + '.date'), cm: cm };
    });
    result.workouts = list(raw.workouts, 'Тренировки', 50000).map(function (entry, index) {
      var path = 'Тренировки[' + index + ']';
      object(entry, path);
      return {
        id: uniqueId(entry.id, workoutIds, path + '.id'),
        date: dateAt(entry.date, path + '.date'),
        title: text(entry.title, path + '.title', 160, false),
        notes: text(entry.notes, path + '.notes', 4000, false),
        exercises: list(entry.exercises, path + '.exercises', 200).map(function (exercise, exerciseIndex) {
          var exercisePath = path + '.exercises[' + exerciseIndex + ']';
          object(exercise, exercisePath);
          var ref = identifier(exercise.exerciseId, exercisePath + '.exerciseId');
          if (!exerciseIds.has(ref)) fail('упражнение отсутствует в справочнике', exercisePath + '.exerciseId');
          return {
            id: uniqueId(exercise.id, sessionExerciseIds, exercisePath + '.id'),
            exerciseId: ref,
            sets: list(exercise.sets, exercisePath + '.sets', 200).map(function (set, setIndex) {
              var setPath = exercisePath + '.sets[' + setIndex + ']';
              object(set, setPath);
              return {
                id: uniqueId(set.id, setIds, setPath + '.id'),
                kg: numeric(set.kg, setPath + '.kg', 0, 1000, false, false),
                reps: numeric(set.reps, setPath + '.reps', 1, 1000, true, false)
              };
            })
          };
        })
      };
    });
    return result;
  }
  function currentWeight(data) {
    if (!data || !Array.isArray(data.weights) || data.weights.length === 0) return null;
    var latest = data.weights.reduce(function (best, item) { return !best || item.date >= best.date ? item : best; }, null);
    return clone(latest);
  }
  function latest(items) {
    if (!Array.isArray(items) || !items.length) return null;
    return clone(items.reduce(function (best, item) { return !best || item.date >= best.date ? item : best; }, null));
  }
  function currentBodyFat(data) { return latest(data && data.bodyFat); }
  function measurementHistory(data, measurementId) {
    return clone((data && data.measurements || []).filter(function (item) { return item.measurementId === measurementId; })).sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); });
  }
  function currentMeasurement(data, measurementId) {
    return latest((data && data.measurements || []).filter(function (item) { return item.measurementId === measurementId; }));
  }
  function summarizeDay(workout) {
    var summary = { sets: 0, reps: 0, volume: 0 };
    (workout.exercises || []).forEach(function (exercise) {
      (exercise.sets || []).forEach(function (set) {
        summary.sets += 1;
        summary.reps += set.reps;
        summary.volume += set.kg * set.reps;
      });
    });
    summary.volume = Math.round((summary.volume + Number.EPSILON) * 1000) / 1000;
    return summary;
  }
  function exerciseHistory(data, exerciseId) {
    var history = [];
    data.workouts.forEach(function (workout) {
      var entries = workout.exercises.filter(function (entry) { return entry.exerciseId === exerciseId; });
      if (entries.length) {
        var allSets = [];
        entries.forEach(function (entry) { allSets = allSets.concat(entry.sets); });
        var summary = summarizeDay({ exercises: [{ sets: allSets }] });
        history.push({ workoutId: workout.id, date: workout.date, title: workout.title, notes: workout.notes, sets: clone(allSets), summary: summary });
      }
    });
    return history.sort(function (a, b) { return b.date.localeCompare(a.date) || b.workoutId.localeCompare(a.workoutId); });
  }
  function createStore(adapter) {
    if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') fail('нужен адаптер хранения с read и write');
    var source = adapter.read();
    var state;
    if (source == null || source === '') state = defaultData();
    else {
      var parsed;
      try { parsed = JSON.parse(source); } catch (error) { fail('сохранённые данные содержат некорректный JSON'); }
      state = validateData(parsed);
    }
    function get() { return clone(state); }
    function replace(raw) {
      var next = validateData(raw);
      var outcome = adapter.write(JSON.stringify(next));
      if (outcome === false) fail('не удалось сохранить данные. Изменения не применены');
      if (outcome && typeof outcome.then === 'function') fail('хранение данных должно быть синхронным');
      state = next;
      return get();
    }
    function transact(mutator) {
      if (typeof mutator !== 'function') fail('ожидается функция изменения данных');
      var draft = get();
      var returned = mutator(draft);
      if (returned && typeof returned.then === 'function') fail('изменение данных должно быть синхронным');
      return replace(returned === undefined ? draft : returned);
    }
    function upsert(items, entry, label) {
      var value = clone(entry);
      if (!value.id) value.id = uid();
      var index = items.findIndex(function (item) { return item.id === value.id; });
      if (index < 0) items.push(value);
      else items[index] = value;
      return value.id;
    }
    function remove(items, id, label) {
      var index = items.findIndex(function (entry) { return entry.id === id; });
      if (index < 0) fail('запись не найдена', label);
      items.splice(index, 1);
    }
    return {
      get: get,
      replace: replace,
      transact: transact,
      updateProfile: function (patch) {
        object(patch, 'Профиль');
        return transact(function (draft) { draft.profile = Object.assign({}, draft.profile, patch); });
      },
      saveWeight: function (entry) {
        object(entry, 'Вес');
        return transact(function (draft) { upsert(draft.weights, entry, 'Вес'); });
      },
      removeWeight: function (id) { return transact(function (draft) { remove(draft.weights, id, 'Вес'); }); },
      saveMeasurementType: function (entry) {
        object(entry, 'Вид замера');
        return transact(function (draft) { upsert(draft.measurementTypes, entry, 'Вид замера'); });
      },
      removeMeasurementType: function (id) {
        return transact(function (draft) {
          remove(draft.measurementTypes, id, 'Вид замера');
          draft.measurements = draft.measurements.filter(function (entry) { return entry.measurementId !== id; });
        });
      },
      saveMeasurement: function (entry) {
        object(entry, 'Замер');
        return transact(function (draft) { upsert(draft.measurements, entry, 'Замер'); });
      },
      removeMeasurement: function (id) { return transact(function (draft) { remove(draft.measurements, id, 'Замер'); }); },
      saveBodyFat: function (entry) {
        object(entry, 'Процент жира');
        return transact(function (draft) { upsert(draft.bodyFat, entry, 'Процент жира'); });
      },
      removeBodyFat: function (id) { return transact(function (draft) { remove(draft.bodyFat, id, 'Процент жира'); }); },
      saveExercise: function (entry) {
        object(entry, 'Упражнение');
        return transact(function (draft) {
          var existing = entry.id && draft.exercises.find(function (item) { return item.id === entry.id; });
          upsert(draft.exercises, Object.assign({}, existing || {}, entry), 'Упражнение');
        });
      },
      archiveExercise: function (id, archived) {
        return transact(function (draft) {
          var entry = draft.exercises.find(function (item) { return item.id === id; });
          if (!entry) fail('упражнение не найдено');
          entry.archived = archived === undefined ? true : archived;
        });
      },
      saveWorkout: function (entry) {
        object(entry, 'Тренировка');
        return transact(function (draft) { upsert(draft.workouts, entry, 'Тренировка'); });
      },
      removeWorkout: function (id) { return transact(function (draft) { remove(draft.workouts, id, 'Тренировка'); }); }
    };
  }
  return Object.freeze({ VERSION: VERSION, ModelError: ModelError, uid: uid, parseDecimal: parseDecimal, normalizeDate: normalizeDate, localToday: localToday, ageOn: ageOn, profileAge: profileAge, defaultData: defaultData, validateData: validateData, currentWeight: currentWeight, currentBodyFat: currentBodyFat, currentMeasurement: currentMeasurement, measurementHistory: measurementHistory, summarizeDay: summarizeDay, exerciseHistory: exerciseHistory, createStore: createStore });
}));
