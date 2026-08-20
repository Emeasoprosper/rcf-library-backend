// services/storage.js
import { google } from 'googleapis'
import { Readable } from 'node:stream'
import { resolveFolderId } from '../config/driveFolders.js'
import { getDelegatedDriveClient } from '../config/googleOAuth.js'

async function getDriveClient() {
  const auth = await getDelegatedDriveClient()
  return google.drive({ version: 'v3', auth })
}

// `category` picks which of your Drive folders (AUDIO, IMG, LECTURE NOTES,
// PAST QUESTIONS, VIDEOS, OTHER BOOKS) the file lands in — see
// config/driveFolders.js for the routing rules. Defaults to the catch-all
// bucket if not specified.
//
// makePublic: false by default now. The actual resource files (PDFs,
// docs, etc.) must stay private — they're only ever served through our
// own authenticated /api/resources/:id/stream route, never a raw Drive
// link. Generated thumbnails/covers still need to be publicly hotlinkable
// as <img> src values, so callers uploading those pass makePublic: true.
export async function uploadToStorage(file, category = 'default', { makePublic = false } = {}) {
  const drive = await getDriveClient()
  const folderId = resolveFolderId(category)

  const response = await drive.files.create({
    requestBody: {
      name: file.originalname,
      parents: folderId ? [folderId] : undefined,
    },
    media: {
      mimeType: file.mimetype,
      body: Readable.from(file.buffer),
    },
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true,
  })

  if (makePublic) {
    try {
      await drive.permissions.create({
        fileId: response.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      })
    } catch (err) {
      console.error(`Uploaded file ${response.data.id} but failed to set public read permission:`, err.message)
    }
  }

  return {
    provider: 'google_drive',
    fileId: response.data.id,
    fileUrl: response.data.webContentLink || response.data.webViewLink,
  }
}

export async function downloadFromStorage(fileId) {
  const drive = await getDriveClient()
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  )
  return Buffer.from(response.data)
}

// Used by the streaming route (GET /api/resources/:id/stream) — returns a
// readable stream instead of buffering the whole file in memory, so large
// PDFs/videos don't blow up server RAM. Caller is responsible for piping
// `data` to the HTTP response and setting headers from `mimeType`/`size`.
export async function streamFromStorage(fileId) {
  const drive = await getDriveClient()

  const metaResponse = await drive.files.get({
    fileId,
    fields: 'mimeType, size, name',
    supportsAllDrives: true,
  })

  const mediaResponse = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  )

  return {
    data: mediaResponse.data, // Node readable stream — pipe this to res
    mimeType: metaResponse.data.mimeType,
    size: metaResponse.data.size ? Number(metaResponse.data.size) : null,
    name: metaResponse.data.name,
  }
}

// Removes the "anyone can read" permission from a file without deleting
// it — used by the one-time lockdown script to make already-approved
// resource files private, and can be reused any time a file needs to
// stop being publicly hotlinkable.
export async function revokePublicAccess(fileId) {
  const drive = await getDriveClient()
  const permissions = await drive.permissions.list({
    fileId,
    fields: 'permissions(id, type)',
    supportsAllDrives: true,
  })
  const publicPerm = permissions.data.permissions?.find((p) => p.type === 'anyone')
  if (publicPerm) {
    await drive.permissions.delete({ fileId, permissionId: publicPerm.id, supportsAllDrives: true })
    return true
  }
  return false
}

// Used when an admin rejects a submission — removes the actual file (or a
// generated thumbnail/cover) from Drive so rejected uploads don't sit
// around consuming storage indefinitely.
export async function deleteFromStorage(fileId) {
  const drive = await getDriveClient()
  await drive.files.delete({ fileId, supportsAllDrives: true })
}

// Converts an already-uploaded Office file (DOC/DOCX/PPT/PPTX) to a real
// PDF via Google Drive's own conversion — solves the "no LibreOffice on
// this host" problem using infrastructure we already have (the service
// account's Drive access). Works identically for legacy .doc, modern
// .docx, .ppt, and .pptx.
//
// How it works: Drive lets you `copy` a file while specifying a
// different target mimeType — for Office formats, giving it a Google
// Docs/Slides mimeType makes Drive itself do the format conversion
// during the copy. `export` on that converted copy then pulls it back
// out as a real PDF. The temporary converted copy is deleted immediately
// after, so nothing lingers in Drive.
export async function convertOfficeFileToPdf(fileId, mimeType) {
  const drive = await getDriveClient()
  const isPresentation = mimeType.includes('presentation') || mimeType === 'application/vnd.ms-powerpoint'
  const targetMimeType = isPresentation
    ? 'application/vnd.google-apps.presentation'
    : 'application/vnd.google-apps.document'

  const copied = await drive.files.copy({
    fileId,
    requestBody: { mimeType: targetMimeType },
    supportsAllDrives: true,
    fields: 'id',
  })
  const convertedId = copied.data.id

  try {
    const exportResponse = await drive.files.export(
      { fileId: convertedId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    )
    return Buffer.from(exportResponse.data)
  } finally {
    await drive.files.delete({ fileId: convertedId, supportsAllDrives: true }).catch((err) => {
      console.error(`Failed to clean up temporary converted file ${convertedId}:`, err.message)
    })
  }
}