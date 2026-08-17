// src/db/seed-categories-departments.js
//
// schema.sql creates the `categories` and `departments` tables and seeds
// `resource_types`, but never seeds categories/departments themselves —
// that's why category/department <select> dropdowns in SuggestMaterial.jsx
// and RequestMaterial.jsx render with nothing to choose (just the
// placeholder option). This fills them in. Safe to re-run — ON CONFLICT
// DO NOTHING skips anything already present.
//
// Content-type categories below (Sermon Notes, Prayer Points, RCF
// Handbook, etc.) are drawn directly from the taxonomy the user provided
// for the RCF Digital Library. This is just the STARTING set — anyone can
// add more from the app itself now (see POST /resources/meta/categories,
// wired into SubmitResource.jsx's upload flow), so this list doesn't need
// to be exhaustive.
//
//   node src/db/seed-categories-departments.js

import { query, pool } from './pool.js'

const CATEGORIES = [
  // Academic / Documents
  'Lecture Notes', 'Course Materials', 'Past Questions', 'Textbooks',
  'Handouts', 'Assignments', 'Tutorials', 'Project Materials',
  'Final Year Projects', 'Seminar Materials', 'Research Papers',
  'Journals', 'Theses', 'Dissertations', 'Study Guides', 'Exam Guides',
  'Departmental Materials',

  // Christian / Spiritual
  'Christian Books', 'Devotionals', 'Bible Study Materials',
  'Bible Commentaries', 'Prayer Guides', 'Prayer Points',
  'Sermon Notes', 'Sermon Outlines', 'Discipleship Materials',
  'Evangelism Materials', 'Tracts', 'Leadership Materials',
  'Christian Living', 'Christian Relationships', 'Spiritual Growth',
  'Spiritual', 'Christian Doctrine', 'Theology', 'Biblical Studies',
  'Church History', 'Christian Biographies', 'Worship',
  'Praise & Gospel Music', 'Testimonies', 'Missions', 'Counseling',

  // RCF-specific
  'RCF Handbook', 'RCF Constitution', 'RCF Manuals', 'RCF Guidelines',
  'RCF Reports', 'RCF Programmes', 'RCF Congress Materials',
  'RCF Convention Materials', 'RCF Retreat Materials',
  'RCF Conference Materials', 'RCF Training Materials',

  // Student & Career
  'Study Tips', 'Career Guides', 'CV & Resume', 'Interview Guides',
  'Scholarship Information', 'Internship Information', 'SIWES Materials',
  'Entrepreneurship', 'Skills Development', 'Personal Development',

  // Media / Misc
  'Christian Films', 'Christian Documentaries', 'Christian Podcasts',
  'Christian Audiobooks', 'Drama', 'Articles', 'Newsletters',
  'Magazines', 'Reports', 'Meeting Minutes', 'Archives',

  // General academic subject areas (kept from the original seed)
  'History', 'Philosophy', 'Science', 'Engineering', 'Computer Science',
  'Business & Management', 'Law', 'Medicine & Health Sciences',
  'Agriculture', 'Education', 'Social Sciences', 'Literature', 'Other',
]

const DEPARTMENTS = [
  'Theology', 'Computer Science', 'Business Administration',
  'Mass Communication', 'Law', 'Medicine and Surgery', 'Nursing Science',
  'Agricultural Economics', 'Crop Science', 'Animal Science',
  'Electrical/Electronic Engineering', 'Mechanical Engineering',
  'Civil Engineering', 'Biochemistry', 'Microbiology', 'Chemistry',
  'Physics', 'Mathematics', 'Economics', 'Political Science',
  'Sociology', 'English Language', 'History and International Studies',
  'Educational Foundations', 'Guidance and Counseling',
]

async function run() {
  console.log('Seeding categories...')
  for (const name of CATEGORIES) {
    await query(`INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name])
  }

  console.log('Seeding departments...')
  for (const name of DEPARTMENTS) {
    await query(`INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name])
  }

  console.log('Done.')
  await pool.end()
}

run().catch((err) => {
  console.error('Seeding failed:', err)
  process.exit(1)
})