/*
 * Copyright (c) AXA Shared Services Spain S.A.
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const fs = require('fs');
const Handlebars = require('handlebars');
const { Language } = require('../language');
const { NerManager } = require('../ner');
const { SentimentManager } = require('../sentiment');
const NlpUtil = require('./nlp-util');
const NlpClassifier = require('./nlp-classifier');
const NlgManager = require('../nlg/nlg-manager');
const NlpExcelReader = require('./nlp-excel-reader');
const { SlotManager } = require('../slot');

/**
 * Class for the NLP Manager.
 * The NLP manager is the one that is able to manage several classifiers,
 * to have multilanguage, and also is the responsible of the NER (Named Entity
 * Recognition).
 *
 * Understanding NER:
 *
 * You can have several entities defined, each one with multilanguage and
 * several texts for each option. Example
 * Entity   Option           English                  Spanish
 * FOOD     Burguer          Burguer, Hamburguer      Hamburguesa
 * FOOD     Salad            Salad                    Ensalada
 * FOOD     Pizza            Pizza                    Pizza
 *
 */
class NlpManager {
  /**
   * Constructor of the class.
   * @param {Object} settings Settings for the NLP Manager.
   */
  constructor(settings) {
    this.settings = settings || {};
    this.guesser = new Language();
    this.nerManager = new NerManager(this.settings.ner);
    this.sentiment = new SentimentManager();
    this.languages = [];
    this.classifiers = {};
    this.slotManager = new SlotManager();
    this.intentDomains = {};
    if (this.settings.languages) {
      this.addLanguage(this.settings.languages);
    }
    if (this.settings.fullSearchWhenGuessed === undefined) {
      this.settings.fullSearchWhenGuessed = true;
    }
    if (this.settings.useNlg === undefined) {
      this.settings.useNlg = true;
    }
    this.processTransformer =
      typeof this.settings.processTransformer === 'function'
        ? this.settings.processTransformer
        : _ => _;
    this.nlgManager = new NlgManager();
  }

  /**
   * Adds a language or several languages to the NLP Manager.
   * @param {String[]} srcLocales Locales to be added.
   */
  addLanguage(srcLocales) {
    const locales = Array.isArray(srcLocales) ? srcLocales : [srcLocales];
    locales.forEach(locale => {
      const truncated = NlpUtil.getTruncatedLocale(locale);
      if (!this.languages.includes(truncated)) {
        this.languages.push(truncated);
      }
      if (!this.classifiers[truncated]) {
        this.classifiers[truncated] = new NlpClassifier({
          language: truncated,
        });
      }
    });
  }

  /**
   * Given a text, try to guess the language, over the languages used for the NLP.
   * @param {String} utterance Text to be guessed.
   * @returns {String} ISO2 locale of the language, or undefined if not found.
   */
  guessLanguage(utterance) {
    const guess = this.guesser.guess(utterance, this.languages, 1);
    return guess && guess.length > 0 ? guess[0].alpha2 : undefined;
  }

  /**
   * Add new texts for an option of an entity for the given languages.
   * @param {String} entityName Name of the entity.
   * @param {String} optionName Name of the option.
   * @param {String[]} languages Languages for adding the texts.
   * @param {String[]} texts Texts to be added.
   */
  addNamedEntityText(entityName, optionName, languages, texts) {
    return this.nerManager.addNamedEntityText(
      entityName,
      optionName,
      languages,
      texts
    );
  }

  /**
   * Adds a new regex named entity
   * @param {String} entityName Name of the entity.
   * @param {RegEx} regex Regular expression
   */
  addRegexEntity(entityName, languages, regex) {
    const entity = this.nerManager.addNamedEntity(entityName, 'regex');
    if (typeof regex === 'string') {
      entity.addStrRegex(languages, regex);
    } else {
      entity.addRegex(languages, regex);
    }
    return entity;
  }

  /**
   * Adds a new trim named entity.
   * @param {String} entityName Name of the entity.
   * @returns {Object} New Trim Named Entity instance.
   */
  addTrimEntity(entityName) {
    return this.nerManager.addNamedEntity(entityName, 'trim');
  }

  /**
   * Remove texts from an option of an entity for the given languages.
   * @param {String} entityName Name of the entity.
   * @param {String} optionName Name of the option.
   * @param {String[]} languages Languages for adding the texts.
   * @param {String[]} texts Texts tobe added.
   */
  removeNamedEntityText(entityName, optionName, languages, texts) {
    return this.nerManager.removeNamedEntityText(
      entityName,
      optionName,
      languages,
      texts
    );
  }

  /**
   * Assign an intent to a domain.
   * @param {String} intent Intent to be assigned.
   * @param {String} domain Domain to include the intent.
   */
  assignDomain(intent, domain) {
    this.intentDomains[intent] = domain;
  }

  /**
   * Returns the domain of a given intent.
   * @param {String} intent Intent name.
   * @returns {String} Domain of the intent.
   */
  getIntentDomain(intent) {
    return this.intentDomains[intent];
  }

  /**
   * Get an object with the intents of each domain.
   */
  getDomains() {
    const keys = Object.keys(this.intentDomains);
    const result = {};
    for (let i = 0, l = keys.length; i < l; i += 1) {
      const intent = keys[i];
      const domain = this.intentDomains[intent];
      if (!result[domain]) {
        result[domain] = [];
      }
      result[domain].push(intent);
    }
    return result;
  }

  /**
   * Adds a new utterance associated to an intent for the given locale.
   * @param {String} srcLocale Locale of the language.
   * @param {String} utterance Text of the utterance.
   * @param {String} intent Intent name.
   */
  addDocument(srcLocale, utterance, intent) {
    let locale = NlpUtil.getTruncatedLocale(srcLocale);
    if (!locale) {
      locale = this.guessLanguage(utterance);
    }
    if (!locale) {
      throw new Error('Locale must be defined');
    }
    const classifier = this.classifiers[locale];
    if (!classifier) {
      throw new Error(`Classifier not found for locale ${locale}`);
    }
    classifier.add(utterance, intent);
    if (this.getIntentDomain(intent) === undefined) {
      this.assignDomain(intent, 'default');
    }
    const entities = this.nerManager.getEntitiesFromUtterance(utterance);
    this.slotManager.addBatch(intent, entities);
  }

  /**
   * Removes an utterance associated to an intent for the given locale.
   * @param {String} srcLocale Locale of the language.
   * @param {String} utterance Text of the utterance.
   * @param {String} intent Intent name.
   */
  removeDocument(srcLocale, utterance, intent) {
    let locale = NlpUtil.getTruncatedLocale(srcLocale);
    if (!locale) {
      locale = this.guessLanguage(utterance);
    }
    if (!locale) {
      throw new Error('Locale must be defined');
    }
    const classifier = this.classifiers[locale];
    if (!classifier) {
      throw new Error(`Classifier not found for locale ${locale}`);
    }
    classifier.remove(utterance, intent);
  }

  /**
   * Adds an answer for a locale and intent.
   * @param {String} locale Locale of the intent.
   * @param {String} intent Intent name.
   * @param {String} answer Text of the answer.
   * @param {String} condition Condition to be evaluated.
   */
  addAnswer(locale, intent, answer, condition) {
    this.nlgManager.addAnswer(locale, intent, answer, condition);
  }

  /**
   * Remove and answer from a locale and intent.
   * @param {String} locale Locale of the intent.
   * @param {String} intent Intent name.
   * @param {String} answer Text of the answer.
   * @param {String} condition Condition to be evaluated.
   */
  removeAnswer(locale, intent, answer, condition) {
    this.nlgManager.removeAnswer(locale, intent, answer, condition);
  }

  /**
   * Train the classifiers for the provided locales. If no locale is
   * provided, then retrain all the classifiers.
   * @param {String[]} locale List of locales for being retrained.
   */
  async train(locale) {
    let languages;
    if (locale) {
      languages = Array.isArray(locale) ? locale : [locale];
    } else {
      ({ languages } = this);
    }
    await Promise.all(
      languages.map(async language => {
        const truncated = NlpUtil.getTruncatedLocale(language);
        const classifier = this.classifiers[truncated];
        if (classifier) {
          await classifier.train();
        }
      })
    );
  }

  /**
   * Given an utterance and a locale, try to classify the utterance into one intent.
   * @param {String} srcLocale Locale of the text. If not provided,
   *                           the locale is guessed.
   * @param {String} srcUtterance Text to be classified
   */
  classify(srcLocale, srcUtterance) {
    let utterance = srcUtterance;
    let locale = srcLocale;
    if (!utterance) {
      utterance = srcLocale;
      locale = this.guessLanguage(utterance);
    }
    const truncated = NlpUtil.getTruncatedLocale(locale);
    const classifier = this.classifiers[truncated];
    if (!classifier) {
      return undefined;
    }
    return classifier.getClassifications(utterance);
  }

  /**
   * Gets the sentiment of an utterance.
   * @param {String} srcLocale Locale of the text. If not provided, is guessed.
   * @param {Promise.String} srcUtterance Texto to analyze the sentiment.
   */
  getSentiment(srcLocale, srcUtterance) {
    let utterance = srcUtterance;
    let locale = srcLocale;
    if (!utterance) {
      utterance = srcLocale;
      locale = this.guessLanguage(utterance);
    }
    const truncated = NlpUtil.getTruncatedLocale(locale);
    return this.sentiment.process(truncated, utterance);
  }

  getAnswer(locale, intent, context) {
    const answer = this.nlgManager.findAnswer(locale, intent, context);
    if (answer && answer.response) {
      return answer.response;
    }
    return undefined;
  }

  /**
   * Indicates if all the classifications has exactly 0.5 score.
   * @param {Object[]} classifications Array of classifications.
   * @returns {boolean} True if all classifications score is 0.5.
   */
  isEqualClassification(classifications) {
    for (let i = 0; i < classifications.length; i += 1) {
      if (classifications[i].value !== 0.5) {
        return false;
      }
    }
    return true;
  }

  /**
   * Process to extract entities from an utterance.
   * @param {string} srcLocale Locale of the utterance, optional.
   * @param {string} srcUtterance Text of the utterance.
   * @param {string[]} whitelist Optional whitelist of entity names.
   * @returns {Object[]} Array of entities.
   */
  async extractEntities(srcLocale, srcUtterance, whitelist) {
    let utterance = srcUtterance;
    let locale = srcLocale;
    if (!utterance) {
      utterance = locale;
      locale = this.guessLanguage(utterance);
    }
    if (!this.languages.includes(NlpUtil.getTruncatedLocale(locale))) {
      locale = this.guessLanguage(utterance);
    }
    const truncated = NlpUtil.getTruncatedLocale(locale);
    const result = await this.nerManager.findEntities(
      utterance,
      truncated,
      whitelist
    );
    return result;
  }

  /**
   * Process an utterance for full classify and analyze. If the locale is
   * not provided, then it will be guessed.
   * Classify the utterance and extract entities from it, returning an
   * object with all the information available.
   * Also calculates the sentiment of the utterance, if possible.
   * @param {String} srcLocale Language locale of the utterance.
   * @param {String} srcUtterance Text of the utterance.
   * @param {Promise.Object} Promise srcContext Context for finding answers.
   */
  async process(srcLocale, srcUtterance, srcContext) {
    let utterance = srcUtterance;
    let locale = srcLocale;
    let languageGuessed = false;
    if (!utterance) {
      utterance = locale;
      locale = this.guessLanguage(utterance);
      languageGuessed = true;
    }
    if (!this.languages.includes(NlpUtil.getTruncatedLocale(locale))) {
      locale = this.guessLanguage(utterance);
      languageGuessed = true;
      if (!locale) {
        [locale] = this.languages;
      }
    }
    const truncated = NlpUtil.getTruncatedLocale(locale);
    const result = {};
    result.locale = locale;
    result.localeIso2 = truncated;
    result.language = (
      this.guesser.languagesAlpha2[result.localeIso2] || {}
    ).name;
    result.utterance = utterance;
    if (languageGuessed && this.settings.fullSearchWhenGuessed) {
      let bestScore;
      let bestClassification;
      this.languages.forEach(language => {
        const classification = this.classify(language, utterance);
        if (classification && classification.length > 0) {
          if (bestScore === undefined || classification[0].value > bestScore) {
            bestScore = classification[0].value;
            bestClassification = classification;
          }
        }
      });
      const optionalUtterance = await this.nerManager.generateEntityUtterance(
        utterance,
        truncated
      );
      this.languages.forEach(language => {
        const classification = this.classify(language, optionalUtterance);
        if (classification && classification.length > 0) {
          if (bestScore === undefined || classification[0].value > bestScore) {
            bestScore = classification[0].value;
            bestClassification = classification;
          }
        }
      });
      result.classification = bestClassification;
    } else {
      result.classification = this.classify(truncated, utterance);
      const optionalUtterance = await this.nerManager.generateEntityUtterance(
        utterance,
        truncated
      );
      if (optionalUtterance !== utterance) {
        const optionalClassification = this.classify(
          truncated,
          optionalUtterance
        );
        if (
          optionalClassification &&
          optionalClassification.length > 0 &&
          optionalClassification[0].value > result.classification[0].value
        ) {
          result.classification = optionalClassification;
        }
      }
    }
    if (
      !result.classification ||
      result.classification.length === 0 ||
      this.isEqualClassification(result.classification)
    ) {
      result.intent = 'None';
      result.domain = 'default';
      result.score = 1;
    } else {
      result.intent = result.classification[0].label;
      result.domain = this.getIntentDomain(result.intent);
      result.score = result.classification[0].value;
    }
    result.entities = await this.nerManager.findEntities(
      utterance,
      truncated,
      this.slotManager.getIntentEntityNames(result.intent)
    );
    const context = srcContext || {};
    result.entities.forEach(entity => {
      context[entity.entity] = entity.option || entity.utteranceText;
    });
    result.sentiment = await this.getSentiment(truncated, utterance);
    const answer = this.getAnswer(truncated, result.intent, context);
    if (answer) {
      result.srcAnswer = answer;
      result.answer = Handlebars.compile(answer)(context);
    }
    if (this.slotManager.process(result, context)) {
      result.entities.forEach(entity => {
        context[entity.entity] = entity.option || entity.utteranceText;
      });
      if (result.srcAnswer) {
        result.answer = Handlebars.compile(result.srcAnswer)(context);
      }
    }
    return this.processTransformer(result);
  }

  /**
   * Clear the NLP Manger.
   */
  clear() {
    this.nerManager = new NerManager(this.settings.ner);
    this.languages = [];
    this.classifiers = {};
    this.slotManager.clear();
    this.nlgManager = new NlgManager();
  }

  /**
   * Load NLP manager information from a string.
   * @param {String|Object} data JSON string or object to load NLP manager information from.
   */
  import(data) {
    const clone = typeof data === 'string' ? JSON.parse(data) : data;

    this.settings = clone.settings;
    this.languages = clone.languages;
    this.nerManager.load(clone.nerManager);
    this.slotManager.load(clone.slotManager);
    this.intentDomains = clone.intentDomains || {};
    this.nlgManager.responses = clone.responses;
    for (let i = 0, l = clone.classifiers.length; i < l; i += 1) {
      const classifierClone = clone.classifiers[i];
      this.addLanguage(classifierClone.language);
      const classifier = this.classifiers[classifierClone.language];

      classifier.docs = classifierClone.docs;
      classifier.features = classifierClone.features;
      const lrc = classifier.settings.classifier;
      const { logistic } = classifierClone;

      lrc.observations = {};
      Object.entries(logistic.observations).forEach(([label, matrix]) => {
        lrc.observations[label] = [];
        matrix.forEach((row, rowIndex) => {
          // Create a array filled with as many zeros as features
          const features = Array(classifier.features.length).fill(0);
          // Set the features for the positions stored with 1. The others remains as zero.
          row.forEach(featPosition => {
            features[featPosition] = 1;
          });
          lrc.observations[label][rowIndex] = features;
        });
      });

      lrc.labels = logistic.labels;
      lrc.classifications = logistic.classifications;
      lrc.observationCount = logistic.observationCount;
      lrc.theta = logistic.theta;
    }
  }

  /**
   * Export NLP manager information as a string.
   * @param {Boolean} minified If true, the returned JSON will have no spacing or indentation.
   * @returns {String} NLP manager information as a JSON string.
   */
  export(minified = false) {
    const clone = {};
    clone.settings = this.settings;
    clone.languages = this.languages;
    clone.intentDomains = this.intentDomains;
    clone.nerManager = this.nerManager.save();
    clone.slotManager = this.slotManager.save();
    clone.classifiers = [];
    clone.responses = this.nlgManager.responses;
    if (this.languages && this.languages.length > 0) {
      this.languages.forEach(language => {
        const classifier = this.classifiers[language];
        const classifierClone = {};
        classifierClone.language = classifier.settings.language;
        classifierClone.docs = classifier.docs;
        classifierClone.features = classifier.features;
        classifierClone.logistic = {};
        const { logistic } = classifierClone;
        const lrc = classifier.settings.classifier;

        logistic.observations = lrc.observations;
        Object.entries(lrc.observations).forEach(([label, matrix]) => {
          matrix.forEach((features, row) => {
            //  Store array of positions for the features equals to 1.
            logistic.observations[label][row] = features
              .map((feat, index) => (feat === 1 ? index : undefined))
              .filter(n => n);
          });
        });

        logistic.labels = lrc.labels;
        logistic.classifications = lrc.classifications;
        logistic.observationCount = lrc.observationCount;
        logistic.theta = lrc.theta;
        clone.classifiers.push(classifierClone);
      });
    }

    return minified ? JSON.stringify(clone) : JSON.stringify(clone, null, 2);
  }

  /**
   * Save the NLP manager information into a file.
   * @param {String} srcFileName Filename for saving the NLP manager.
   */
  save(srcFileName) {
    const fileName = srcFileName || 'model.nlp';
    fs.writeFileSync(fileName, this.export(), 'utf8');
  }

  /**
   * Load the NLP manager information from a file.
   * @param {String} srcFilename Filename for loading the NLP manager.
   */
  load(srcFileName) {
    const fileName = srcFileName || 'model.nlp';
    const data = fs.readFileSync(fileName, 'utf8');
    this.import(data);
  }

  /**
   * Load the NLP manager information from an excel file.
   * @param {Sting} srcFileName File name of the excel.
   */
  loadExcel(srcFileName) {
    this.clear();
    const fileName = srcFileName || 'model.xls';
    const reader = new NlpExcelReader(this);
    reader.load(fileName);
  }
}

module.exports = NlpManager;
