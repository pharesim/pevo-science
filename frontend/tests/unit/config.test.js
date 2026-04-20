import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getAppTag,
  getAppVersion,
  getAppId,
  getDiscordUrl,
  getGithubUrl,
  getMaxUploadSize,
  getMaxUploadSizeMB,
} from '../../src/config.js';

describe('config', () => {
  beforeEach(() => {
    delete window.__PEVO_CONFIG__;
  });

  afterEach(() => {
    delete window.__PEVO_CONFIG__;
  });

  describe('with window.__PEVO_CONFIG__ unset', () => {
    it('returns defaults for every getter', () => {
      expect(getAppTag()).toBe('pevo');
      expect(getAppVersion()).toBe('0.1');
      expect(getAppId()).toBe('pevo/0.1');
      expect(getMaxUploadSize()).toBe(10 * 1024 * 1024);
      expect(getMaxUploadSizeMB()).toBe(10);
      expect(getDiscordUrl()).toBe('');
      expect(getGithubUrl()).toBe('');
    });
  });

  describe('with window.__PEVO_CONFIG__ populated', () => {
    beforeEach(() => {
      window.__PEVO_CONFIG__ = {
        appTag: 'pevotest',
        appVersion: '2.0',
        discordUrl: 'https://discord.example/invite/abc',
        githubUrl: 'https://github.example/pevo',
        maxUploadSize: 25 * 1024 * 1024,
      };
    });

    it('returns injected values for every getter', () => {
      expect(getAppTag()).toBe('pevotest');
      expect(getAppVersion()).toBe('2.0');
      expect(getAppId()).toBe('pevotest/2.0');
      expect(getMaxUploadSize()).toBe(25 * 1024 * 1024);
      expect(getMaxUploadSizeMB()).toBe(25);
      expect(getDiscordUrl()).toBe('https://discord.example/invite/abc');
      expect(getGithubUrl()).toBe('https://github.example/pevo');
    });
  });

  describe('isolation', () => {
    it('does not leak window.__PEVO_CONFIG__ between cases', () => {
      expect(window.__PEVO_CONFIG__).toBeUndefined();
      expect(getAppTag()).toBe('pevo');
    });
  });
});
