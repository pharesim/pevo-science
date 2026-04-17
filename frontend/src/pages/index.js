// Page registry — maps route names to { init, template }
// All 26 routes are rendered by pageMount via Alpine.mutateDom().

import { initHomePage, homePageTemplate } from './home.js';
import { initPapersPage, papersPageTemplate } from './papers.js';
import { initPaperDetailPage, paperDetailPageTemplate } from './paper-detail.js';
import { initPublishPage, publishPageTemplate } from './publish.js';
import { initEditPage, editPageTemplate } from './edit.js';
import { initReviewPage, reviewPageTemplate } from './review.js';
import { initSearchPage, searchPageTemplate } from './search.js';
import { initBridgePage, bridgePageTemplate } from './bridge.js';
import { initProfilePage, profilePageTemplate } from './profile.js';
import { initAccreditationPage, accreditationPageTemplate } from './accreditation.js';
import { initAccreditationVerifyPage, accreditationVerifyPageTemplate } from './accreditation-verify.js';
import { initAccreditationOrcidCallbackPage, accreditationOrcidCallbackPageTemplate } from './accreditation-orcid-callback.js';
import { initResearchersPage, researchersPageTemplate } from './researchers.js';
import { initStatsPage, statsPageTemplate } from './stats.js';
import { initAboutPage, aboutPageTemplate } from './about.js';
import { initFaqPage, faqPageTemplate } from './faq.js';
import { initGettingStartedPage, gettingStartedPageTemplate } from './getting-started.js';
import { initContactPage, contactPageTemplate } from './contact.js';
import { initBlogPage, blogPageTemplate } from './blog.js';
import { initBlogPostPage, blogPostPageTemplate } from './blog-post.js';
import { initSignupPage, signupPageTemplate } from './signup.js';
import { initSignupOrcidCallbackPage, signupOrcidCallbackPageTemplate } from './signup-orcid-callback.js';
import { initSignupVerifyPage, signupVerifyPageTemplate } from './signup-verify.js';
import { initLoginPage, loginPageTemplate } from './login.js';
import { initResetPasswordPage, resetPasswordPageTemplate } from './reset-password.js';
import { initSettingsPage, settingsPageTemplate } from './settings.js';
import { initSettingsVerifyEmailPage, settingsVerifyEmailPageTemplate } from './settings-verify-email.js';

export const pages = {
  'home':                        { init: initHomePage, template: homePageTemplate },
  'papers':                      { init: initPapersPage, template: papersPageTemplate },
  'paper-detail':                { init: initPaperDetailPage, template: paperDetailPageTemplate },
  'publish':                     { init: initPublishPage, template: publishPageTemplate },
  'edit':                        { init: initEditPage, template: editPageTemplate },
  'review':                      { init: initReviewPage, template: reviewPageTemplate },
  'search':                      { init: initSearchPage, template: searchPageTemplate },
  'bridge':                      { init: initBridgePage, template: bridgePageTemplate },
  'profile':                     { init: initProfilePage, template: profilePageTemplate },
  'accreditation':               { init: initAccreditationPage, template: accreditationPageTemplate },
  'accreditation-verify':        { init: initAccreditationVerifyPage, template: accreditationVerifyPageTemplate },
  'accreditation-orcid-callback':{ init: initAccreditationOrcidCallbackPage, template: accreditationOrcidCallbackPageTemplate },
  'researchers':                 { init: initResearchersPage, template: researchersPageTemplate },
  'stats':                       { init: initStatsPage, template: statsPageTemplate },
  'about':                       { init: initAboutPage, template: aboutPageTemplate },
  'faq':                         { init: initFaqPage, template: faqPageTemplate },
  'getting-started':             { init: initGettingStartedPage, template: gettingStartedPageTemplate },
  'contact':                     { init: initContactPage, template: contactPageTemplate },
  'blog':                        { init: initBlogPage, template: blogPageTemplate },
  'blog-post':                   { init: initBlogPostPage, template: blogPostPageTemplate },
  'signup':                      { init: initSignupPage, template: signupPageTemplate },
  'signup-orcid-callback':       { init: initSignupOrcidCallbackPage, template: signupOrcidCallbackPageTemplate },
  'signup-verify':               { init: initSignupVerifyPage, template: signupVerifyPageTemplate },
  'login':                       { init: initLoginPage, template: loginPageTemplate },
  'reset-password':              { init: initResetPasswordPage, template: resetPasswordPageTemplate },
  'settings':                    { init: initSettingsPage, template: settingsPageTemplate },
  'settings-verify-email':       { init: initSettingsVerifyEmailPage, template: settingsVerifyEmailPageTemplate },
};
