import Alpine from 'alpinejs';
import { fetchBridgeLookup, fetchBridgeCheck, registerBridgePaper } from '../api.js';

const DISCIPLINE_TAXONOMY = [
  { field: 'Natural Sciences', subfields: ['Mathematics', 'Computer Science', 'Physics', 'Chemistry', 'Earth Sciences', 'Biology', 'Astronomy'] },
  { field: 'Engineering and Technology', subfields: ['Civil Engineering', 'Electrical Engineering', 'Mechanical Engineering', 'Chemical Engineering', 'Materials Engineering', 'Biomedical Engineering', 'Environmental Engineering'] },
  { field: 'Medical and Health Sciences', subfields: ['Basic Medicine', 'Clinical Medicine', 'Health Sciences', 'Neuroscience', 'Pharmacology'] },
  { field: 'Agricultural and Veterinary Sciences', subfields: ['Agriculture', 'Animal Science', 'Veterinary Science', 'Forestry'] },
  { field: 'Social Sciences', subfields: ['Psychology', 'Economics', 'Education', 'Sociology', 'Law', 'Political Science', 'Geography'] },
  { field: 'Humanities and Arts', subfields: ['History', 'Philosophy', 'Languages and Literature', 'Arts', 'Theology'] },
];

export function initBridgePage() {
  Alpine.data('bridgePage', () => ({
    identifier: '',
    lookingUp: false,
    lookupError: '',
    lookup: null,
    check: null,

    discipline: '',
    disciplineSearch: '',
    disciplineDropdownOpen: false,
    keywordsText: '',
    language: '',

    step: 'idle',
    errorMessage: '',

    navigate(path) { Alpine.store('router').navigate(path); },
    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },

    get filteredTaxonomy() {
      if (!this.disciplineSearch.trim()) return DISCIPLINE_TAXONOMY;
      const q = this.disciplineSearch.toLowerCase();
      return DISCIPLINE_TAXONOMY
        .map((group) => ({
          ...group,
          subfields: group.subfields.filter((sf) => sf.toLowerCase().includes(q)),
        }))
        .filter((group) => group.subfields.length > 0);
    },

    get isDuplicate() { return this.check?.exists === true; },

    get canRegister() {
      return this.lookup && !this.isDuplicate && this.discipline && this.step === 'idle';
    },

    get disciplineDisplayValue() {
      return this.disciplineDropdownOpen ? this.disciplineSearch : (this.discipline || this.disciplineSearch);
    },

    selectDiscipline(sf) {
      this.discipline = sf;
      this.disciplineSearch = sf;
      this.disciplineDropdownOpen = false;
    },

    clearDiscipline() {
      this.discipline = '';
      this.disciplineSearch = '';
    },

    onDisciplineInput(e) {
      this.disciplineSearch = e.target.value;
      this.discipline = e.target.value.trim();
      this.disciplineDropdownOpen = true;
    },

    prefillDiscipline(lookup) {
      if (!lookup) return;
      // Prefer explicit subjects from the source API
      if (lookup.subjects && lookup.subjects.length > 0) {
        this.selectDiscipline(lookup.subjects[0]);
        return;
      }
      // Fall back to journal/source name (strip common prefixes)
      if (lookup.source_name) {
        const name = lookup.source_name
          .replace(/^frontiers\s+in\s+/i, '')
          .replace(/^journal\s+of\s+(the\s+)?/i, '')
          .replace(/^proceedings\s+of\s+(the\s+)?/i, '');
        if (name.length > 0 && name.length < 60) {
          this.selectDiscipline(name.charAt(0).toUpperCase() + name.slice(1));
        }
      }
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch (err) {
        Alpine.store('toast').show(err.message || this.$t('common.connectionFailed'), 'error');
      }
    },

    async handleLookup() {
      if (!this.identifier.trim()) return;
      this.lookingUp = true;
      this.lookupError = '';
      this.lookup = null;
      this.check = null;
      try {
        const [lookupRes, checkRes] = await Promise.all([
          fetchBridgeLookup(this.identifier.trim()),
          fetchBridgeCheck(this.identifier.trim()),
        ]);
        this.lookup = lookupRes.data;
        this.check = checkRes.data;
        this.prefillDiscipline(this.lookup);
      } catch (err) {
        const code = err.code || '';
        this.lookupError = code === 'INTERNAL_ERROR' ? this.$t('bridge.lookupUnavailable') : this.$t('bridge.lookupFailed');
      } finally {
        this.lookingUp = false;
      }
    },

    async handleRegister() {
      if (!this.username || !this.discipline) return;

      try {
        this.step = 'registering';
        const keywords = this.keywordsText.split(',').map((k) => k.trim()).filter(Boolean);
        const res = await registerBridgePaper({
          identifier: this.identifier.trim(),
          discipline: this.discipline,
          keywords: keywords.length > 0 ? keywords : undefined,
          language: this.language.trim() || undefined,
        });

        this.step = 'success';
        Alpine.store('toast').show(this.$t('bridge.stepSuccess'), 'success');
        setTimeout(() => {
          this.navigate(`/paper/${res.data.author}/${res.data.permlink}`);
        }, 1500);
      } catch (err) {
        this.step = 'error';
        this.errorMessage = err.message || 'Registration failed';
      }
    },
  }));
}
