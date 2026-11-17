import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { User } from '../src/db/models.js';

describe('Signup, user role, and admin full CRUD + deactivation', () => {
  let adminCookie = '';

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('Gah95841!!', 10);
    await User.create({
      email: 'ali.smartlogicsllc@gmail.com',
      username: 'ali.admin',
      role: 'admin',
      active: true,
      passwordHash,
    });
    const res = await request(app).post('/auth/login').send({ email: 'ali.smartlogicsllc@gmail.com', password: 'Gah95841!!' }).expect(200);
    adminCookie = res.headers['set-cookie']?.[0] ?? '';
  });

  it('allows public signup with default role "user" and active=true, and rejects duplicate emails', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'newuser@example.com', username: 'newuser', password: 'Password123!' })
      .expect(201);

    expect(res.body).toMatchObject({
      email: 'newuser@example.com',
      username: 'newuser',
      role: 'user',
      active: true,
    });
    expect(res.headers['set-cookie']).toBeDefined();

    // Duplicate email rejected
    await request(app).post('/auth/signup').send({ email: 'newuser@example.com', password: 'Password123!' }).expect(409);
  });

  it('prevents non-admin "user" role from accessing /users', async () => {
    const signup = await request(app)
      .post('/auth/signup')
      .send({ email: 'regular@example.com', username: 'regular', password: 'Password123!' })
      .expect(201);
    const userCookie = signup.headers['set-cookie']?.[0] ?? '';
    await request(app).get('/users').set('Cookie', userCookie).expect(403);
  });

  it('lets admin update username, email, password, role, and deactivate/reactivate a user', async () => {
    const created = await request(app)
      .post('/users')
      .set('Cookie', adminCookie)
      .send({ email: 'managed@example.com', username: 'managed1', password: 'Password123!', role: 'user' })
      .expect(201);

    const id = created.body.id as string;

    // Admin updates username, email, password, and deactivates user
    const updated = await request(app)
      .patch(`/users/${id}`)
      .set('Cookie', adminCookie)
      .send({
        email: 'managed.updated@example.com',
        username: 'managed_new',
        password: 'NewPassword99!',
        active: false,
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      email: 'managed.updated@example.com',
      username: 'managed_new',
      active: false,
      role: 'user',
    });

    // Deactivated user cannot log in
    await request(app).post('/auth/login').send({ email: 'managed.updated@example.com', password: 'NewPassword99!' }).expect(403);

    // Admin reactivates user -> login succeeds with new password
    await request(app).patch(`/users/${id}`).set('Cookie', adminCookie).send({ active: true }).expect(200);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'managed.updated@example.com', password: 'NewPassword99!' })
      .expect(200);
    expect(login.body.username).toBe('managed_new');

    // Admin deletes user
    await request(app).delete(`/users/${id}`).set('Cookie', adminCookie).expect(204);
  });
});
